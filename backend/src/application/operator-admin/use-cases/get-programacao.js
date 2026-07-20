// backend/src/application/operator-admin/use-cases/get-programacao.js
//
// Read model da tela "Programação". Consulta as viagens SPX/Shopee DIRETO no portal
// (via sidecar spx-bot → GET /api/line_haul/agency/trip/list), NÃO mais pela API da
// Torre (/api/spx/asp). Vantagens da fonte direta: sem dependência/chave da Torre e,
// principalmente, o campo `acceptance_status` (0=não aceita, 1=já aceita) — que a
// Torre não expõe — permite mostrar "Aceitar" só nas viagens ainda não aceitas.
//
// 3 visualizações = os 3 tabs do SPX (query_type 1/2/3): Planejado / Aceito / Concluído.
// Por enquanto o único cliente é a Shopee (fonte ASPX/SPX); o read model já devolve
// `clientes` para evoluir p/ multi-cliente sem quebra.
//
// Resiliência: cada tab é buscado em paralelo e best-effort — se um falhar, os outros
// aparecem (warning por tab). Todos falham → 503 (sidecar fora do ar). Sem sidecar
// configurado → 503.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import {
  fetchSpxTripsByTab,
  isAspxAcceptWriteEnabled,
  SpxSidecarUnavailable,
} from "../../../infrastructure/spx/spx-allocation-client.js";

const TABS = [
  // Planejado precisa de janela de data (inclui futuro). Aceito/Concluído não usam
  // janela (a API SPX ignora/rejeita os params).
  { key: "planejado", queryType: 1, opts: { daysBack: 45, daysForward: 15, maxPages: 30 } },
  { key: "aceito", queryType: 2, opts: { maxPages: 30 } },
  // Concluído usa o endpoint /history/list (query_type=3 no sidecar) com janela
  // `mtime` — a janela é derivada de days_back/days_forward no sidecar.
  { key: "concluido", queryType: 3, opts: { daysBack: 30, daysForward: 2, maxPages: 15 } },
];

// trip_status_name (SPX) → rótulo operacional (espelha a tradução da aba `asp`).
const STATUS_OPERACIONAL = {
  created: "AGUARDANDO ACEITE",
  pending: "AGUARDANDO ACEITE",
  assigning: "AGUARDANDO CHEGAR NO CLIENTE",
  assigned: "AGUARDANDO CHEGAR NO CLIENTE",
  loading: "CARREGANDO",
  seal: "CARREGANDO",
  departed: "CARREGADO",
  arrived: "AGUARDANDO DESCARGA",
  unseal: "DESCARREGANDO",
  operating: "DESCARREGANDO",
  unloaded: "DESCARREGADO",
  completed: "DESCARREGADO",
  cancelled: "CANCELADO",
};

function statusOperacional(statusName) {
  const key = String(statusName || "").trim().toLowerCase();
  return STATUS_OPERACIONAL[key] || String(statusName || "").toUpperCase();
}

// epoch (segundos) → { data: 'YYYY-MM-DD', horario: 'HH:MM' } no fuso America/Sao_Paulo.
// 0/ausente → null. Node 22 tem ICU completo, então o timeZone é confiável.
function epochToBRT(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return { data: null, horario: null };
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
  if (!p.year) return { data: null, horario: null };
  const horario = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  return { data: `${p.year}-${p.month}-${p.day}`, horario };
}

// Estação SPX: "LM Hub_CE_Juazeiro do Norte" (ou "[10768]LM Hub_CE_..." pela Torre) →
//   label:  "Cidade/UF · TIPO"     (exibição, mantém o tipo LM Hub/SoC/...)
//   cityUf: "Cidade/UF"            (casar com catálogo de rotas / prefill do modal)
function parseStation(raw) {
  const s = String(raw || "").trim();
  if (!s) return { label: "", cityUf: "" };
  const body = s.replace(/^\[\d+\]\s*/, "");
  const m = body.match(/^(.*?)_([A-Z]{2})_(.+)$/);
  if (!m) return { label: body, cityUf: body };
  const tipo = m[1].trim();
  const uf = m[2];
  const cidade = m[3].replace(/_/g, " ").trim();
  const cityUf = `${cidade}/${uf}`;
  return { label: `${cityUf}${tipo ? ` · ${tipo}` : ""}`, cityUf };
}

function normalizeRow(t, tab) {
  const lh = String(t.trip_number ?? "").trim();
  const statusRaw = t.trip_status_name || String(t.trip_status ?? "");
  const origemStation = parseStation(t.origem);
  const destinoStation = parseStation(t.destino);
  const { data, horario } = epochToBRT(t.carregamento_ts ?? t.std);
  const { data: dataDescarga, horario: horarioDescarga } = epochToBRT(t.descarga_ts);
  // Instante ABSOLUTO do carregamento (epoch em segundos, UTC) — usado p/ decidir
  // se a viagem está atrasada sem depender de fuso. O front também usa p/ manter a
  // tela sempre em dia com o relógio (esconde a viagem quando o horário passa).
  const carregSeconds = Number(t.carregamento_ts ?? t.std);
  const carregamentoTs = Number.isFinite(carregSeconds) && carregSeconds > 0 ? carregSeconds : null;
  const isLinehaul = lh.toUpperCase().startsWith("LT");
  const motorista = String(t.driver_name ?? "").trim();
  const placa = [t.cavalo, t.carreta].map((v) => String(v ?? "").trim()).filter(Boolean).join(" / ");
  const acceptanceStatus = typeof t.acceptance_status === "number" ? t.acceptance_status : null;
  return {
    lh,
    nome: t.trip_name || "",
    statusRaw,
    statusOperacional: statusOperacional(statusRaw),
    motorista,
    veiculo: t.vehicle_type || "",
    placa,
    origem: origemStation.label,
    destino: destinoStation.label,
    origemRaw: t.origem || "",
    destinoRaw: t.destino || "",
    origemCidadeUf: origemStation.cityUf,
    destinoCidadeUf: destinoStation.cityUf,
    data,
    horario,
    carregamentoTs,
    dataDescarga,
    horarioDescarga,
    tab,
    cliente: "Shopee",
    isLinehaul,
    acceptanceStatus,
    // Pode aceitar = Planejado, line-haul e AINDA NÃO aceita (acceptance_status 0).
    // As já aceitas (1) não mostram "Aceitar".
    podeAceitar: tab === "planejado" && isLinehaul && acceptanceStatus === 0,
    // Aguardando motorista = já aceita, sem motorista atribuído ainda.
    aguardandoMotorista: tab === "planejado" && isLinehaul && acceptanceStatus === 1 && !motorista,
    // Preenchido adiante (dedup visual do botão "Lançar").
    jaLancada: false,
  };
}

// ─── Fonte Nestlé (Projeto Galileu) ─────────────────────────────────────────────
// A tela também consome as ofertas/programações da Nestlé (tabela nestle_ofertas,
// populada pelo sidecar bots/galileu). Espelha o Shopee: ver/filtrar/ordenar/lançar,
// SEM aceitar (o aceite da Nestlé é feito pelo próprio Galileu/robo_aceite). Prefixo
// NESTLE- no `lh` p/ não colidir com os "LT…" do SPX e p/ o dedup de lançamento.

const NESTLE_FINAIS = new Set(["CANCELADO", "DECLINADA", "RECUSA LEILAO", "EXPIRADA", "FINALIZADO"]);

// Status "mortos" da oferta Nestlé: leilão recusado, expirada, cancelada ou declinada.
// Não são ação da Programação e não têm motorista/embarque — o Galileo devolve milhares
// delas no histórico e entopem a tela (sem motorista), além de poderem sobrepor a oferta
// ATIVA do mesmo grupo no DISTINCT ON. Filtradas fora do read model. FINALIZADO NÃO entra
// aqui: é viagem concluída de verdade (com motorista) e continua indo p/ a aba Concluído.
const NESTLE_STATUS_MORTOS = ["RECUSA LEILAO", "EXPIRADA", "CANCELADO", "CANCELADO PELA CENTRAL", "DECLINADA"];

// datetime ISO naive do Galileo (wall-clock BRT, ex.: '2026-07-20T08:00:00') →
// { data:'YYYY-MM-DD', horario:'HH:MM', ts: epoch segundos (interpretando como BRT) }.
function parseBrtIso(iso) {
  const s = String(iso ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return { data: null, horario: null, ts: null };
  const [, y, mo, d, h, mi] = m;
  const data = `${y}-${mo}-${d}`;
  const horario = `${h}:${mi}`;
  const ms = Date.parse(`${data}T${horario}:00-03:00`);
  return { data, horario, ts: Number.isFinite(ms) ? Math.floor(ms / 1000) : null };
}

// Aba da carga Nestlé. O status do EMBARQUE (viagem real) manda quando existe:
// FINALIZADO → concluído; qualquer outro status de embarque em progresso → aceito.
// Sem embarque, deriva do status da oferta (PENDENTE → planejado; finais → concluído).
function nestleTab(ofertaStatus, embStatus) {
  const emb = String(embStatus ?? "").toUpperCase().trim();
  if (emb === "FINALIZADO") return "concluido";
  if (emb) return "aceito"; // EM VIAGEM / AGUARDANDO INICIO / PENDENTE FINALIZACAO / ...
  const s = String(ofertaStatus ?? "").toUpperCase().trim();
  if (s === "PENDENTE") return "planejado";
  if (NESTLE_FINAIS.has(s)) return "concluido";
  return "aceito"; // ACEITA / EMBARQUE EMITIDO sem detalhe ainda
}

function normalizeNestleRow(o) {
  // "Código de viagem" da Nestlé = grupos_id (ex.: B101462743) — o ID do grupo/viagem
  // do Galileo (mesmo formato dos códigos Nestlé já usados no sistema). É também a chave
  // de lançamento (lh_manual)/dedup. Fallbacks: codembarque, depois codprogcoleta.
  const grupoId = String(o.grupos_id ?? "").trim();
  const codEmb = String(o.codembarque ?? "").trim();
  const codProg = String(o.codprogcoleta ?? "").trim();
  const lh = grupoId || codEmb || codProg;
  const origemCidadeUf = [o.emporig_nomecid, o.emporig_uf].map((v) => String(v ?? "").trim()).filter(Boolean).join("/");
  const destinoCidadeUf = [o.empdest_nomecid, o.empdest_uf].map((v) => String(v ?? "").trim()).filter(Boolean).join("/");
  const carreg = parseBrtIso(o.dtahrprevatual);
  const desc = parseBrtIso(o.dtahrpreventrega);
  // Status/motorista/placa REAIS vêm do embarque (join) quando a carga já foi aceita;
  // senão, o status da oferta. O embarque é a verdade sobre a viagem.
  const statusRaw = String(o.emb_status || o.descrstatprogcoleta || "");
  return {
    lh,
    nome: codProg, // referência da programação (a viagem em si é o lh/codembarque)
    statusRaw,
    statusOperacional: statusRaw.toUpperCase(),
    motorista: String(o.emb_motorista ?? "").trim(),
    veiculo: o.tpveic_nome || "",
    placa: String(o.emb_placa ?? "").trim(),
    origem: origemCidadeUf,
    destino: destinoCidadeUf,
    origemRaw: o.emporig_nomeciduf || origemCidadeUf,
    destinoRaw: o.empdest_nomeciduf || destinoCidadeUf,
    origemCidadeUf,
    destinoCidadeUf,
    data: carreg.data,
    horario: carreg.horario,
    carregamentoTs: carreg.ts,
    dataDescarga: desc.data,
    horarioDescarga: desc.horario,
    tab: nestleTab(o.descrstatprogcoleta, o.emb_status),
    cliente: "Nestle",
    source: "nestle-galileu",
    // Elegível a lançar (equivalente ao line-haul do SPX). Aceite DESLIGADO p/ Nestlé.
    isLinehaul: true,
    acceptanceStatus: null,
    podeAceitar: false,
    aguardandoMotorista: false,
    jaLancada: false,
    tipo: o.tipo || null, // CONTRATO | ADICIONAL | LEILAO (dimensão extra p/ filtro)
  };
}

// Lê as ofertas Nestlé do próprio banco (populadas pelo coletor bots/galileu).
// Tolerante a tabela ausente (prod sem migration) → []. Sem PostgREST aqui (pg direto),
// então não há o teto de 1000 linhas.
async function defaultFetchNestleOfertas() {
  return withPgClient(async (client) => {
    try {
      // Dedup por grupo (grupos_id = a viagem); ofertas sem grupo caem no codprogcoleta.
      // LEFT JOIN nestle_embarques (por codembarque) traz o estado REAL da viagem aceita:
      // motorista, placa e status (FINALIZADO/EM VIAGEM/…) — sobrepõe o status defasado da
      // oferta. Uma linha por viagem, a mais recente por carregamento.
      const { rows } = await client.query(
        `SELECT DISTINCT ON (COALESCE(o.grupos_id, o.codprogcoleta))
                o.codprogcoleta, o.codembarque, o.grupos_id, o.descrstatprogcoleta,
                o.emporig_nomecid, o.emporig_uf, o.emporig_nomeciduf,
                o.empdest_nomecid, o.empdest_uf, o.empdest_nomeciduf,
                o.tpveic_nome, o.tipo, o.dtahrprevatual, o.dtahrpreventrega, o.dtahraceite,
                e.mot1_nome  AS emb_motorista,
                e.placacarreta AS emb_placa,
                e.descrstatembarque AS emb_status,
                e.entrega_dtahrfim  AS emb_entrega_fim
           FROM public.nestle_ofertas o
           LEFT JOIN public.nestle_embarques e ON e.codembarque = o.codembarque
          WHERE COALESCE(UPPER(TRIM(o.descrstatprogcoleta)), '') <> ALL($1::text[])
          ORDER BY COALESCE(o.grupos_id, o.codprogcoleta), o.dtahrprevatual DESC NULLS LAST
          LIMIT 3000`,
        [NESTLE_STATUS_MORTOS],
      );
      return rows;
    } catch (err) {
      if (err?.code === "42P01") return []; // tabela ainda não criada
      throw err;
    }
  });
}

// Quais LHs já viraram carga no sistema (sheet_lh OU lh_manual) — UI mostra "Lançada".
async function defaultListLaunchedLhs(lhs) {
  const unique = [...new Set((lhs || []).filter(Boolean))];
  if (unique.length === 0) return new Set();
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      "SELECT sheet_lh, lh_manual FROM public.cargas WHERE sheet_lh = ANY($1::text[]) OR lh_manual = ANY($1::text[])",
      [unique],
    );
    const set = new Set();
    for (const r of rows) {
      if (r.sheet_lh) set.add(r.sheet_lh);
      if (r.lh_manual) set.add(r.lh_manual);
    }
    return set;
  });
}

/**
 * @param {{ correlationId?: string, force?: boolean, deps?: object }} args
 *   force=true ignora o cache do proxy → busca AO VIVO no portal SPX (usado pelo
 *   botão "Atualizar" p/ garantir que nada fique remanescente na tela).
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function getProgramacao({ correlationId, force = false, tabs = null, deps = {} } = {}) {
  const getTrips = deps.fetchTripsByTab || fetchSpxTripsByTab;
  const listLaunched = deps.listLaunchedLhs || defaultListLaunchedLhs;
  const getNestle = deps.fetchNestleOfertas || defaultFetchNestleOfertas;
  // Fonte Nestlé ligada por padrão; kill-switch por env (PROGRAMACAO_NESTLE_ENABLED=false).
  const nestleEnabled = deps.nestleEnabled ?? process.env.PROGRAMACAO_NESTLE_ENABLED !== "false";
  const wall = getSaoPauloWallClock();
  const todayIso = deps.today || wall.dateIso;
  const nowTimeIso = deps.nowTime || wall.timeIso;
  const nowMs = deps.nowMs ?? Date.now();

  // `tabs` restringe quais abas buscar (lazy) — o Concluído (645+ viagens, lento) só
  // é buscado ao abrir a aba, deixando o load inicial (Planejado+Aceito) rápido.
  const wanted = Array.isArray(tabs) && tabs.length ? new Set(tabs) : null;
  const activeTabs = wanted ? TABS.filter((t) => wanted.has(t.key)) : TABS;

  // Nestlé roda EM PARALELO com o SPX (não sequencial) — o LEFT JOIN nestle_embarques
  // leva ~1s; paralelizar evita somar essa latência ao load (importante no Concluído,
  // que já é lento). Best-effort: erro vira warning, não derruba a resposta.
  const nestlePromise = nestleEnabled
    ? Promise.resolve()
        .then(() => getNestle())
        .then((rows) => ({ ok: true, rows }))
        .catch(() => ({ ok: false, rows: [] }))
    : Promise.resolve({ ok: true, rows: [] });

  const settled = await Promise.allSettled(activeTabs.map((t) => getTrips(t.queryType, { ...t.opts, force }, { correlationId })));

  const warnings = [];
  let rows = [];
  let anyUnavailable = false;

  settled.forEach((r, i) => {
    const t = activeTabs[i];
    if (r.status !== "fulfilled") {
      warnings.push(`tab_${t.key}_unavailable`);
      if (r.reason instanceof SpxSidecarUnavailable) anyUnavailable = true;
      return;
    }
    const tabTrips = Array.isArray(r.value?.trips) ? r.value.trips : [];
    if (r.value?.truncated) warnings.push(`tab_${t.key}_truncated`);
    rows = rows.concat(tabTrips.map((raw) => normalizeRow(raw, t.key)));
  });

  // Fonte Nestlé (Projeto Galileu) — resolve o fetch já iniciado em paralelo. Respeita
  // o filtro de abas (wanted). Se falhou, os SPX ainda aparecem (warning).
  let nestleRows = [];
  const nestleResult = await nestlePromise;
  if (nestleResult.ok) {
    nestleRows = (nestleResult.rows || [])
      .map(normalizeNestleRow)
      .filter((r) => r.lh && (!wanted || wanted.has(r.tab)));
    rows = rows.concat(nestleRows);
  } else {
    warnings.push("nestle_unavailable");
  }

  // Todos os tabs SPX pedidos falharam E não há Nestlé → sidecar fora do ar / não configurado.
  if (settled.length > 0 && settled.every((r) => r.status !== "fulfilled") && nestleRows.length === 0) {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        configured: !anyUnavailable, // se caiu por Unavailable, provavelmente sem sidecar/sessão
        error: "SPX_UNAVAILABLE",
        message: "Não foi possível consultar as viagens SPX agora (sidecar SPX indisponível).",
        warnings,
        meta: { correlationId },
      },
    };
  }

  // "Atrasada" = carregamento (STD) anterior ao INSTANTE atual — não só o dia.
  // Usa o epoch absoluto do SPX (sem ambiguidade de fuso); sem ele, cai no relógio
  // de parede de São Paulo (data+horário são BRT). O front reavalia com o relógio
  // corrente p/ a tela nunca ficar desatualizada entre os fetches.
  for (const r of rows) {
    r.expirada = r.carregamentoTs
      ? r.carregamentoTs * 1000 < nowMs
      : Boolean(r.data && (r.data < todayIso || (r.data === todayIso && r.horario && r.horario < nowTimeIso)));
  }
  // Planejado atrasado é backlog inútil (não dá p/ lançar/vender) → SAI do painel.
  // Aceito/Concluído são naturalmente de datas passadas — ficam.
  rows = rows.filter((r) => !(r.tab === "planejado" && r.expirada));

  try {
    const launched = await listLaunched(rows.map((r) => r.lh));
    for (const r of rows) r.jaLancada = r.lh ? launched.has(r.lh) : false;
  } catch {
    warnings.push("launched_lookup_failed");
  }

  const byTab = {
    planejado: rows.filter((r) => r.tab === "planejado").length,
    aceito: rows.filter((r) => r.tab === "aceito").length,
    concluido: rows.filter((r) => r.tab === "concluido").length,
  };
  const summary = {
    planejado: byTab.planejado,
    aceito: byTab.aceito,
    concluido: byTab.concluido,
    total: rows.length,
    podeAceitar: rows.filter((r) => r.podeAceitar).length,
    aguardandoMotorista: rows.filter((r) => r.aguardandoMotorista).length,
    jaLancadas: rows.filter((r) => r.jaLancada).length,
  };

  return {
    statusCode: 200,
    payload: {
      ok: true,
      configured: true,
      source: "spx-direct",
      acceptWriteEnabled: isAspxAcceptWriteEnabled(),
      clientes: [
        { id: "shopee", nome: "Shopee", source: "aspx" },
        ...(nestleRows.length ? [{ id: "nestle", nome: "Nestle", source: "nestle-galileu" }] : []),
      ],
      byTab,
      summary,
      warnings,
      rows,
      meta: { correlationId, fetchedAt: new Date().toISOString() },
    },
  };
}
