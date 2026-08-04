// backend/src/application/operator-admin/use-cases/spx-schedule-overlay.js
//
// Overlay de CARGA/DESCARGA (agenda) das viagens SPX/Shopee no Monitor, puxando os
// horários AO VIVO da Torre (/api/spx/asp) — colunas "ETA ORIGEM" (carga) e "ETA
// DESTINO" (descarga). Mantém a Carga/Descarga do Monitor sincronizadas com o SPX sem
// depender do ciclo LENTO da planilha (sheet → sync). A planilha vira só o fallback.
//
// IMPORTANTE — por que é seguro usar a Torre aqui (o overlay de STATUS está desligado):
// o problema que desligou o status era a TRADUÇÃO do "Status Operacional" da Torre,
// que conflava origem↔destino ("Arrived" na origem virava "AGUARDANDO DESCARGA"). As
// colunas ETA ORIGEM/ETA DESTINO são GEOGRÁFICAS e explícitas — carga=origem,
// descarga=destino, sem ambiguidade —, então não sofrem desse problema.
//
// PROGRAMADO (previsto) é a fonte: é EXATAMENTE o que a planilha Shopee espelha hoje
// na Carga/Descarga (verificado — a coluna "data carregamento" == "ETA ORIGEM
// PROGRAMADO" e "data descarga" == "ETA DESTINO PROGRAMADO", casando 100% nas linhas
// frescas). Ou seja: mesmo valor da planilha, só que AO VIVO (sem esperar o sync). REAL
// (o que realmente aconteceu) fica só como fallback quando o PROGRAMADO vier vazio.
// Best-effort: qualquer falha da Torre → sem overlay (Monitor segue com a planilha).

import { fetchSpxTrips, SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { fetchSpxTripsByTab } from "../../../infrastructure/spx/spx-allocation-client.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const LH_TRIP_COL = "LH Trip Number";
// PROGRAMADO primeiro (== semântica da planilha), REAL só como fallback.
const CARGA_COLS = ["ETA ORIGEM PROGRAMADO", "ETA ORIGEM REAL"];
const DESCARGA_COLS = ["ETA DESTINO PROGRAMADO", "ETA DESTINO REAL"];

// "DD/MM/YYYY HH:MM" (formato da Torre) → { label, dateIso, timeIso, at } ou null.
//   label  = "DD/MM/YYYY HH:MM" (== formato exibido no Monitor: carregamentoLabel)
//   dateIso= "YYYY-MM-DD"       (row.data — ordenação/filtro de carga)
//   timeIso= "HH:MM"            (row.horario)
//   at     = "YYYY-MM-DDTHH:MM" (row.cargaAt/descargaAt — datetime-local)
function parseAspDateTime(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi] = m;
  return {
    label: `${d}/${mo}/${y} ${h}:${mi}`,
    dateIso: `${y}-${mo}-${d}`,
    timeIso: `${h}:${mi}`,
    at: `${y}-${mo}-${d}T${h}:${mi}`,
  };
}

function firstNonEmpty(row, cols) {
  for (const c of cols) {
    const v = String(row?.[c] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * Índice lh(trip_number) → { carga, descarga } (cada um { label, dateIso, timeIso, at }
 * ou null) das viagens SPX (Torre asp). Best-effort: null em qualquer falha (sem chave,
 * Torre fora, circuito aberto) — o Monitor não sobrepõe e nunca quebra por causa disso.
 * Reusa fetchSpxTrips (cache 60s + circuit breaker) → 1 chamada barata amortizada.
 *
 * ORÇAMENTO DE TEMPO (timeoutMs, default 4s): este overlay roda no caminho de LEITURA
 * do Monitor (dentro do Promise.all de resolveSheetMonitorResponse). A Torre pode estar
 * UP-porém-LENTA — o circuit breaker do cliente só cobre erro/timeout(20s)/5xx, não uma
 * resposta lenta —, então sem um teto próprio um cache-miss travaria a tela inteira até
 * 20s. Estourando o orçamento, degrada p/ SEM overlay (a Carga/Descarga cai na planilha)
 * em vez de bloquear o Monitor. O fetch segue em background e popula o cache (60s) p/ o
 * próximo request.
 *
 * @param {{ daysBack?: number, daysFwd?: number, timeoutMs?: number, correlationId?: string, deps?: { fetchSpx?: typeof fetchSpxTrips } }} [args]
 * @returns {Promise<Map<string, { carga: object|null, descarga: object|null }>|null>}
 */
export async function fetchSpxScheduleIndex({ daysBack = 30, daysFwd = 15, timeoutMs = 4000, correlationId = null, deps = {} } = {}) {
  const fetchSpx = deps.fetchSpx || fetchSpxTrips;
  let budgetTimer;
  try {
    const payload = await Promise.race([
      fetchSpx({ daysBack, daysFwd }, { correlationId }),
      new Promise((_, reject) => {
        budgetTimer = setTimeout(() => reject(new Error(`spx-schedule-timeout:${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    clearTimeout(budgetTimer);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const map = new Map();
    for (const r of rows) {
      const lh = String(r?.[LH_TRIP_COL] ?? "").trim();
      if (!lh) continue;
      const carga = parseAspDateTime(firstNonEmpty(r, CARGA_COLS));
      const descarga = parseAspDateTime(firstNonEmpty(r, DESCARGA_COLS));
      if (carga || descarga) map.set(lh, { carga, descarga });
    }
    return map;
  } catch (err) {
    clearTimeout(budgetTimer);
    // Sem chave configurada é esperado em alguns ambientes — não polui como erro.
    if (!(err instanceof SpxAspNotConfigured)) {
      logStructuredEvent("warn", "sheet-monitor.spx-schedule-index-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

// ─── Fonte PRIMÁRIA: o sidecar SPX (mesmo payload do status ao vivo) ──────────
//
// POR QUE trocar a Torre pelo sidecar como fonte principal: o orçamento de 4s
// acima degrada para SEM overlay, e é o que acontece em produção sempre que o
// cache de 60s da Torre está frio — medido em 04/08/2026, a chamada estourou os
// 4000ms e o índice voltou NULL. Efeito na tela: a carga Shopee cuja célula de
// carregamento está vazia na planilha aparece SEM horário (ex.: LT0Q8602CPLC1,
// que o portal SPX dava como 06/08/2026 18:00 e a planilha não tinha).
//
// O sidecar `spx-bot` já é consultado no MESMO request do Monitor para o STATUS ao
// vivo (`fetchSpxStatusIndexFromSnapshot`), com as MESMAS abas e janelas — e o
// payload de viagem que ele devolve traz `carregamento_ts`/`descarga_ts` (epoch).
// Reusando `fetchSpxTripsByTab` com os mesmos parâmetros, a agenda sai do fetch
// que já ia acontecer (cache de 30s por aba, compartilhado com a Programação):
// nenhuma chamada de rede a mais, sem orçamento apertado, e a agenda do Monitor
// passa a ser exatamente a mesma que a Programação mostra.
//
// Bônus de correção semântica: `carregamento_ts` é a STA da ORIGEM (chegada p/
// carregar) desde o fix do sidecar — a mesma coisa que "ETA ORIGEM PROGRAMADO" da
// Torre (conferido ao vivo: as duas fontes deram valores idênticos nas 4 viagens
// comparadas). A Torre continua como FALLBACK, que cobre o que o sidecar não vê
// nessas abas (viagens antigas/concluídas).

const SPX_PLANEJADO_QUERY_TYPE = 1;
const SPX_ACEITO_QUERY_TYPE = 2;

let _sidecarIndexCache = null; // { value: Map|null, expiresAt: number }

function sidecarIndexTtlMs() {
  // Mesmo TTL do índice de status (a fonte é a mesma) — 90s por padrão.
  const s = Number(process.env.SPX_MONITOR_STATUS_CACHE_SECONDS);
  return (Number.isFinite(s) && s >= 0 ? s : 90) * 1000;
}

/** Primeiro epoch POSITIVO da lista (0/null/NaN = "sem data" no payload SPX). */
function firstEpoch(...candidatos) {
  for (const c of candidatos) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** epoch (segundos, UTC) → o mesmo shape de `parseAspDateTime`, no fuso
 *  America/Sao_Paulo. 0/ausente/inválido → null. Node 22 tem ICU completo. */
export function epochToSchedule(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(n * 1000));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  if (!p.year) return null;
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    label: `${p.day}/${p.month}/${p.year} ${hour}:${p.minute}`,
    dateIso: `${p.year}-${p.month}-${p.day}`,
    timeIso: `${hour}:${p.minute}`,
    at: `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`,
  };
}

/**
 * Índice lh → { carga, descarga } lido do sidecar SPX (abas Planejado + Aceito),
 * memoizado ~90s. Best-effort por aba: uma aba fora do ar não derruba a outra;
 * ambas fora → null + backoff de 30s (não martela o sidecar caído).
 *
 * @param {{ correlationId?: string|null, force?: boolean, deps?: { fetchSpxTripsByTab?: typeof fetchSpxTripsByTab } }} [args]
 * @returns {Promise<Map<string, { carga: object|null, descarga: object|null }>|null>}
 */
export async function fetchSpxScheduleIndexFromSidecar({ correlationId = null, force = false, deps = {} } = {}) {
  if (!force && _sidecarIndexCache && _sidecarIndexCache.expiresAt > Date.now()) {
    return _sidecarIndexCache.value;
  }
  const fetchTab = deps.fetchSpxTripsByTab || fetchSpxTripsByTab;
  // MESMAS abas/janelas do índice de status — é o que faz o fetch ser compartilhado.
  const tabs = [
    { qt: SPX_PLANEJADO_QUERY_TYPE, opts: { daysBack: 45, daysForward: 30, maxPages: 30 } },
    { qt: SPX_ACEITO_QUERY_TYPE, opts: { maxPages: 30 } },
  ];
  try {
    const perTab = await Promise.all(
      tabs.map((t) =>
        fetchTab(t.qt, t.opts, { correlationId, timeoutMs: 10000 })
          .then((r) => (Array.isArray(r?.trips) ? r.trips : []))
          .catch(() => null),
      ),
    );
    if (perTab.every((r) => r === null)) throw new Error("todas as abas SPX de agenda falharam");
    const map = new Map();
    // Planejado antes, Aceito depois: a MESMA viagem nas duas abas fica com a
    // versão mais avançada (determinístico, igual ao índice de status).
    for (const trips of perTab) {
      if (!trips) continue;
      for (const t of trips) {
        const lh = String(t?.trip_number ?? "").trim();
        if (!lh) continue;
        // `carregamento_ts` já é a STA da origem (o sidecar normaliza); `std` é o
        // fallback histórico. 0 conta como AUSENTE — no payload SPX ele significa
        // "sem data", e um `??` deixaria o 0 vencer o fallback.
        const carga = epochToSchedule(firstEpoch(t?.carregamento_ts, t?.std));
        const descarga = epochToSchedule(t?.descarga_ts);
        if (carga || descarga) map.set(lh, { carga, descarga });
      }
    }
    const ttl = sidecarIndexTtlMs();
    if (ttl > 0) _sidecarIndexCache = { value: map, expiresAt: Date.now() + ttl };
    return map;
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor.spx-schedule-sidecar-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    _sidecarIndexCache = { value: null, expiresAt: Date.now() + 30_000 };
    return null;
  }
}

/**
 * Funde índices AO VIVO keyed por LH (agenda ou status) por precedência: o
 * PRIMEIRO que tiver a chave vence. Usado p/ "sidecar primeiro, Torre como
 * fallback" (a Torre só preenche os LHs que o sidecar não viu — viagens fora das
 * abas Planejado/Aceito) e p/ "SPX ∪ Nestlé" no índice de status. Índices
 * null/vazios são ignorados; nada casando → null (o caller não sobrepõe nada).
 *
 * @param {...(Map|null|undefined)} indexes por ordem de precedência
 * @returns {Map|null}
 */
export function mergeLiveIndexes(...indexes) {
  const out = new Map();
  for (const idx of indexes) {
    if (!idx || idx.size === 0) continue;
    for (const [lh, v] of idx) {
      if (!out.has(lh)) out.set(lh, v);
    }
  }
  return out.size > 0 ? out : null;
}

/** Só p/ teste: zera o memo do índice do sidecar entre casos. */
export function __resetSpxScheduleSidecarCache() {
  _sidecarIndexCache = null;
}

/**
 * Sobrepõe a Carga/Descarga EXIBIDA de uma linha da planilha pelo horário AO VIVO do
 * SPX (Torre), casando por LH (== trip_number). Só linhas Shopee casam (LH "LT…");
 * Nestlé/importadas/sistema não têm match → inalteradas. Sem índice/sem match → linha
 * inalterada. Toca SÓ campos de agenda (carga/descarga) — nunca motorista/status.
 *
 * @param {object} row linha do Monitor (tem `lh`, `carregamentoLabel`, `descargaLabel`, `data`, `horario`…)
 * @param {{ spxScheduleByLh: Map<string,{carga:object|null,descarga:object|null}>|null }} ctx
 */
export function applySpxSchedule(row, { spxScheduleByLh } = {}) {
  if (!spxScheduleByLh || spxScheduleByLh.size === 0) return row;
  const lh = row?.lh;
  if (!lh) return row;
  const sched = spxScheduleByLh.get(String(lh).trim());
  if (!sched || (!sched.carga && !sched.descarga)) return row;
  const next = { ...row };
  if (sched.carga) {
    next.carregamentoLabel = sched.carga.label;
    next.data = sched.carga.dateIso; // ordenação/filtro de carga acompanham o SPX
    next.horario = sched.carga.timeIso;
    next.cargaAt = sched.carga.at;
  }
  if (sched.descarga) {
    next.descargaLabel = sched.descarga.label;
    next.descargaAt = sched.descarga.at; // habilita o filtro de descarga p/ linhas Shopee
  }
  return next;
}
