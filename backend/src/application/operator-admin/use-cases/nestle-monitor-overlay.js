// backend/src/application/operator-admin/use-cases/nestle-monitor-overlay.js
//
// Overlay de AGENDA (carga/descarga) e STATUS OPERACIONAL das linhas NESTLÉ do
// Monitor, puxando a verdade do Projeto Galileu — as tabelas `nestle_ofertas` /
// `nestle_embarques`, populadas pelo sidecar `bots/galileu`. É o equivalente
// Nestlé de `spx-schedule-overlay.js` + `spx-operational-status.js` (Shopee).
//
// POR QUE existe: a Nestlé não passa pelo SPX, então nenhum dos dois overlays ao
// vivo do Monitor a alcança (ambos casam por `trip_number` "LT…"). O que sobrava
// era o valor congelado no instante do lançamento/sync. Medido em produção
// (04/08/2026):
//   - 26 das 34 cargas Nestlé LANÇADAS estavam com STATUS VAZIO no sistema
//     enquanto o Galileu já dizia EM VIAGEM / AGUARDANDO INICIO / FINALIZADO;
//   - 3 continuavam presas no placeholder "A confirmar" (hoje/00:00) mesmo com o
//     Galileu já tendo a data real (ex.: 2026-08-05T10:00);
//   - 1 exibia CARREGADO com o Galileu em FINALIZADO.
//
// ─── AGENDA: O GALILEU MANDA (decisão de operação) ─────────────────────────────
//
// A coluna de carregamento da planilha Nestlé NÃO é espelho do Galileu: das 118
// linhas com valor nas duas fontes, ZERO coincidem (59 com a mesma data e hora
// diferente, 59 com data diferente). Ou seja, é uma cópia manual que envelheceu.
// A operação decidiu que a fonte é o Galileu, sempre — inclusive sobrepondo a
// planilha. (Para a Shopee a regra continua a outra: lá a planilha É espelho do
// portal, e o overlay só a mantém em dia.)
//
// PREVISTO primeiro, REAL só como fallback — MESMA regra do overlay Shopee
// ("ETA ORIGEM PROGRAMADO" antes de "ETA ORIGEM REAL"): a agenda que a operação
// negocia é a prevista; a real (chegada/fim de coleta) só entra quando não há
// previsão. Conferido no Galileu: `coleta_dtahrprevini` == `oferta.dtahrprevatual`
// nas linhas frescas, e `coleta_dtahrchegada`/`coleta_dtahrfim` são o que de fato
// aconteceu.
//
// ─── ÍNDICE DIRIGIDO PELO EMBARQUE (viagem já carregada / em viagem) ───────────
//
// O índice é montado a partir de `nestle_embarques` (a VIAGEM real) e só depois
// completado com as ofertas ainda sem embarque. Assim uma carga que já carregou e
// está rodando entra sempre — ela existe como embarque, e depender do filtro de
// ofertas "ofertáveis" (como faz a tela Programação) a deixaria de fora.
//
// Custo: duas leituras pequenas no banco LOCAL (598 embarques + ~590 ofertas
// vivas), memoizadas ~60s. Nenhuma chamada externa — ao contrário do overlay
// Shopee, que depende do sidecar/Torre.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { lookupByMonitorLh } from "../../../domain/operator-admin/monitor-lh.js";

/** Kill-switch. LIGADO por padrão; NESTLE_MONITOR_LIVE_ENABLED=false volta ao
 *  valor congelado (planilha/lançamento). */
export function isNestleMonitorLiveEnabled() {
  return (process.env.NESTLE_MONITOR_LIVE_ENABLED || "").trim().toLowerCase() !== "false";
}

function indexTtlMs() {
  const s = Number(process.env.NESTLE_MONITOR_CACHE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 60) * 1000;
}

let _indexCache = null; // { value: Map|null, expiresAt: number }

/** Só as ofertas VIVAS entram no índice: as mortas (leilão recusado, expirada,
 *  cancelada, declinada) são 10k+ linhas de histórico que não têm agenda a
 *  sincronizar e poderiam sobrepor a oferta ativa do mesmo grupo. Espelha
 *  NESTLE_STATUS_MORTOS de get-programacao.js. */
const OFERTA_STATUS_MORTOS = [
  "RECUSA LEILAO",
  "EXPIRADA",
  "CANCELADO",
  "CANCELADO PELA CENTRAL",
  "DECLINADA",
];

// ─── Status: vocabulário Galileu → vocabulário do Monitor ─────────────────────
//
// O Monitor tem UMA régua de status (STATUS_PIPELINE em
// domain/operator-admin/aspx-status-rules.js) e é ela que sustenta a trava
// "só avança" — a que impede o overlay ao vivo de rebaixar `CTE EM EMISSÃO` /
// `CTE ENVIADO` / `NO SHOW`. Injetar o rótulo cru do Galileu ("EM VIAGEM") na
// coluna deixaria dois vocabulários convivendo e a trava sem posição p/ comparar
// (ambos fora do pipeline → nunca avança, nunca rebaixa: o status voltaria a
// congelar). Então traduzimos.
//
// A tradução não foi inventada: é a que a PRÓPRIA planilha Nestlé já aplica,
// medida no cruzamento das 111 linhas com embarque (04/08/2026):
//   FINALIZADO → DESCARREGADO ...... 98 linhas (dominante)
//   EM VIAGEM  → (vazio) ............ 5 linhas (a planilha nunca preenchia)
// Os demais estados seguem a posição operacional equivalente.
//
// CANCELADO fica DE FORA de propósito (sem tradução → sem overlay): gravar/exibir
// cancelamento dispara a cascata de rota (`sweepCancelledCascades` casa
// COALESCE(alloc_status, sheet_status) LIKE '%cancel%') e já derrubou 39
// motoristas da fila retroativamente. Desmascarar cancelamento é decisão de
// operação — mesma exceção de `reconcile-aspx-status-launched.js`. Na medição, as
// 3 linhas CANCELADO no Galileu estão como NOSHOW na planilha: decisão humana,
// preservada.
const NESTLE_STATUS_OPERACIONAL = {
  "AGUARDANDO INICIO": "AGUARDANDO CHEGAR NO CLIENTE",
  "EM VIAGEM": "CARREGADO",
  "PENDENTE FINALIZACAO": "AGUARDANDO DESCARGA",
  FINALIZADO: "DESCARREGADO",
};

/**
 * Rótulo operacional do Monitor para um status de embarque do Galileu, ou "" se
 * não há tradução (cancelamento, status novo/desconhecido) — nesse caso não há
 * overlay e o valor exibido hoje é preservado.
 *
 * O Galileu qualifica o "pendente finalização" no próprio rótulo
 * ("PENDENTE DE VINCULO (PENDENTE FINALIZACAO)", "PENDENTE DE DEV. (…)",
 * "AG. DELIVERY DE DEVOLUÇÃO (…)" — 27 das 31 linhas nesse estado). Todas são o
 * MESMO estado operacional, então o casamento é por CONTEÚDO, não por igualdade.
 *
 * @param {string|null|undefined} raw `descrstatembarque`
 * @returns {string} rótulo do pipeline do Monitor, ou ""
 */
export function nestleStatusOperacional(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return "";
  if (NESTLE_STATUS_OPERACIONAL[s]) return NESTLE_STATUS_OPERACIONAL[s];
  if (s.includes("PENDENTE FINALIZACAO")) return NESTLE_STATUS_OPERACIONAL["PENDENTE FINALIZACAO"];
  return "";
}

// ─── Datas ────────────────────────────────────────────────────────────────────

/**
 * datetime naive do Galileu ('2026-08-04T16:00:00' ou '2026-08-04 16:00') — já em
 * wall-clock BRT — no MESMO shape que o overlay Shopee produz, p/ as duas fontes
 * alimentarem os mesmos campos da linha:
 *   label  = "DD/MM/YYYY HH:MM"  (carregamentoLabel/descargaLabel)
 *   dateIso= "YYYY-MM-DD"        (row.data — ordenação/filtro)
 *   timeIso= "HH:MM"             (row.horario)
 *   at     = "YYYY-MM-DDTHH:MM"  (row.cargaAt/descargaAt — input datetime-local)
 * Inválido/ausente → null.
 */
export function parseGalileuDateTime(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return {
    label: `${d}/${mo}/${y} ${h}:${mi}`,
    dateIso: `${y}-${mo}-${d}`,
    timeIso: `${h}:${mi}`,
    at: `${y}-${mo}-${d}T${h}:${mi}`,
  };
}

/** PREVISTO primeiro, REAL como fallback (regra do overlay Shopee). */
function agenda(previsto, real) {
  return parseGalileuDateTime(previsto) || parseGalileuDateTime(real);
}

// ─── Índice ───────────────────────────────────────────────────────────────────

/** Registra a entrada em TODAS as chaves pelas quais o Monitor pode identificar a
 *  viagem Nestlé: grupos_id (o `lh_manual` da carga lançada e o LH da planilha),
 *  codembarque e codprogcoleta. `overwrite=false` preserva quem já está no mapa
 *  (as ofertas são carregadas depois dos embarques e não podem rebaixá-los). */
function registrar(map, chaves, valor, overwrite) {
  for (const raw of chaves) {
    const k = String(raw ?? "").trim();
    if (!k) continue;
    if (!overwrite && map.has(k)) continue;
    map.set(k, valor);
  }
}

/**
 * Índice lh → { carga, descarga, status } da verdade Nestlé (Galileu).
 * `status` já vem traduzido p/ o vocabulário do Monitor ("" quando sem tradução).
 *
 * Best-effort e memoizado (~60s): tabela ausente (prod sem migration) ou erro de
 * leitura → índice VAZIO/anterior, nunca exceção — o Monitor segue servindo o
 * valor congelado em vez de quebrar.
 *
 * @param {{ correlationId?: string|null, force?: boolean, deps?: { withPgClient?: typeof withPgClient } }} [args]
 * @returns {Promise<Map<string, { carga: object|null, descarga: object|null, status: string }>|null>}
 */
export async function fetchNestleMonitorIndex({ correlationId = null, force = false, deps = {} } = {}) {
  if (!isNestleMonitorLiveEnabled()) return null;
  if (!force && _indexCache && _indexCache.expiresAt > Date.now()) return _indexCache.value;
  const run = deps.withPgClient || withPgClient;

  try {
    const map = await run(async (client) => {
      const out = new Map();

      // 1) OFERTAS vivas — a viagem que ainda não tem embarque (planejada/aceita).
      //    Uma linha por grupo, a mais recente por carregamento (mesmo DISTINCT ON
      //    da tela Programação, p/ as duas telas concordarem sobre qual oferta vale).
      const { rows: ofertas } = await client.query(
        `SELECT DISTINCT ON (COALESCE(o.grupos_id, o.codprogcoleta))
                o.grupos_id, o.codembarque, o.codprogcoleta,
                o.dtahrprevatual, o.dtahrpreventrega
           FROM public.nestle_ofertas o
          WHERE UPPER(COALESCE(o.descrstatprogcoleta, '')) <> ALL ($1::text[])
          ORDER BY COALESCE(o.grupos_id, o.codprogcoleta), o.dtahrprevatual DESC NULLS LAST`,
        [OFERTA_STATUS_MORTOS],
      );
      for (const o of ofertas) {
        const carga = agenda(o.dtahrprevatual, null);
        const descarga = agenda(o.dtahrpreventrega, null);
        if (!carga && !descarga) continue;
        registrar(out, [o.grupos_id, o.codembarque, o.codprogcoleta], { carga, descarga, status: "" }, true);
      }

      // 2) EMBARQUES — a VIAGEM real (inclui as que já carregaram e estão em
      //    viagem). Sobrepõe a oferta: é o estado atual, com status e agenda real.
      //    LEFT JOIN na oferta só p/ recuperar as chaves (grupos_id/codprogcoleta)
      //    e a previsão quando o embarque não a trouxer.
      const { rows: embarques } = await client.query(
        `SELECT e.codembarque, o.grupos_id, o.codprogcoleta, e.descrstatembarque,
                COALESCE(e.coleta_dtahrprevini, o.dtahrprevatual)   AS carreg_previsto,
                COALESCE(e.coleta_dtahrfim, e.coleta_dtahrchegada)  AS carreg_real,
                COALESCE(e.entrega_dtahrprevini, o.dtahrpreventrega) AS desc_previsto,
                COALESCE(e.entrega_dtahrfim, e.entrega_dtahrchegada) AS desc_real
           FROM public.nestle_embarques e
           LEFT JOIN public.nestle_ofertas o ON o.codembarque = e.codembarque`,
      );
      for (const e of embarques) {
        const carga = agenda(e.carreg_previsto, e.carreg_real);
        const descarga = agenda(e.desc_previsto, e.desc_real);
        const status = nestleStatusOperacional(e.descrstatembarque);
        if (!carga && !descarga && !status) continue;
        registrar(out, [e.grupos_id, e.codembarque, e.codprogcoleta], { carga, descarga, status }, true);
      }

      return out;
    });

    const ttl = indexTtlMs();
    if (ttl > 0) _indexCache = { value: map, expiresAt: Date.now() + ttl };
    return map;
  } catch (err) {
    if (err?.code !== "42P01") {
      logStructuredEvent("warn", "sheet-monitor.nestle-index-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // Backoff curto: não repete a leitura a cada request do Monitor enquanto o
    // erro persiste. Recupera sozinho no próximo ciclo.
    _indexCache = { value: null, expiresAt: Date.now() + 30_000 };
    return null;
  }
}

/** Entrada do índice Nestlé para o LH de uma linha do Monitor — tolerante ao LH
 *  MULTI-CÓDIGO da Nestlé (ver domain/operator-admin/monitor-lh.js). */
export function nestleIndexLookup(index, lh) {
  return lookupByMonitorLh(index, lh) ?? null;
}

/**
 * Sobrepõe a AGENDA (carga/descarga) de uma linha do Monitor pela verdade do
 * Galileu. Só linhas Nestlé casam (LH "B1…"/codembarque); Shopee/importadas
 * passam inalteradas. Toca SÓ campos de agenda — nunca motorista/status.
 *
 * Diferente do overlay Shopee, aqui o Galileu sobrepõe MESMO havendo valor na
 * linha (ver o bloco AGENDA no topo: a planilha Nestlé é cópia manual velha).
 *
 * @param {object} row linha do Monitor (`lh`, `carregamentoLabel`, `data`, `horario`…)
 * @param {{ nestleByLh: Map|null }} ctx
 */
export function applyNestleSchedule(row, { nestleByLh } = {}) {
  const hit = nestleIndexLookup(nestleByLh, row?.lh);
  if (!hit || (!hit.carga && !hit.descarga)) return row;
  const next = { ...row };
  if (hit.carga) {
    next.carregamentoLabel = hit.carga.label;
    next.data = hit.carga.dateIso; // ordenação/filtro acompanham o Galileu
    next.horario = hit.carga.timeIso;
    next.cargaAt = hit.carga.at;
  }
  if (hit.descarga) {
    next.descargaLabel = hit.descarga.label;
    next.descargaAt = hit.descarga.at;
  }
  return next;
}

/**
 * Índice lh → status operacional (vocabulário do Monitor) das viagens Nestlé, no
 * MESMO shape de `fetchSpxStatusIndexFromSnapshot`. Serve p/ ser mesclado no
 * `spxStatusByLh`: assim `applySpxOperationalStatus` (gate de motorista + trava
 * "só avança" + `row.spxStatus` que o front trata como autoritativo) vale para a
 * Nestlé sem nenhuma ramificação por fonte.
 *
 * Só entram as chaves com status traduzido — sem tradução (cancelamento,
 * desconhecido) não há sobreposição.
 */
export function nestleStatusIndex(index) {
  if (!index || index.size === 0) return null;
  const map = new Map();
  for (const [lh, v] of index) {
    if (v?.status) map.set(lh, v.status);
  }
  return map.size > 0 ? map : null;
}

/** Só p/ teste: zera o memo entre casos. */
export function __resetNestleIndexCache() {
  _indexCache = null;
}
