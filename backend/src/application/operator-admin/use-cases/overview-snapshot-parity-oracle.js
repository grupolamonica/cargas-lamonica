/**
 * ORÁCULO DE PARIDADE do snapshot do Painel — módulo de SUPORTE A TESTE (não é
 * usado por nenhum caminho de produção, mesma natureza de `test-harness.js`).
 *
 * Por que ele existe: a prova de que a agregação server-side não mudou nenhum
 * número da tela precisa comparar o SQL com o builder do NAVEGADOR
 * (`frontend/src/lib/overviewMetrics.ts`), e os dois não rodam no mesmo runner —
 * o front é TS com alias `@/` (vitest do frontend, jsdom) e o pg-mem é
 * devDependency do backend. A prova é então encadeada por este oráculo, que
 * reimplementa em JS puro EXATAMENTE o que as consultas de
 * `overview-snapshot-read-model.js` fazem:
 *
 *   1. front (buildOverviewSnapshot)  ==  montagem(oráculo(fixture))
 *      → frontend/src/lib/overviewMetrics.serverParity.test.ts
 *   2. oráculo(fixture)               ==  SQL(fixture no pg-mem)
 *      → overview-snapshot-read-model.test.js
 *
 * Por transitividade, front == SQL. Se o SQL mudar sem o oráculo mudar (ou
 * vice-versa), a prova 2 quebra.
 *
 * As linhas de entrada têm a forma do PostgREST (o que o navegador recebia):
 * `data` como "YYYY-MM-DD", timestamps como texto ISO, `distancia_km` numérico.
 * A saída tem a forma do driver do Postgres (o que o SQL devolve): timestamps e
 * `data` como Date.
 */
import {
  ACTIVE_CLAIM_STATUSES,
  ACTIVE_LEAD_STATUSES,
  BOOKED_LOAD_STATUSES,
  OVERVIEW_WINDOW_ROWS,
  TERMINAL_LOAD_STATUSES,
  resolveSaoPauloDayBounds,
} from "./overview-snapshot-metrics.js";

/**
 * Instante de referência da fixture. Escolhido DE PROPÓSITO na janela em que a
 * data UTC já virou e a de São Paulo não: 2026-08-01T02:00Z == 2026-07-31 23:00
 * BRT. É aí que uma porta ingênua (parseISO no container em UTC) desloca tudo em
 * 3h e troca "saída nas próximas 24h" por "atrasada".
 */
export const OVERVIEW_PARITY_NOW = "2026-08-01T02:00:00.000Z";

/**
 * Fixture ÚNICA das duas provas de paridade (front x oráculo x SQL). Linhas na
 * forma do PostgREST, já em ordem `created_at DESC` — é a ordem em que o
 * navegador recebia as linhas, e a fila de atenção depende dela nos empates de
 * idade.
 *
 * Casos de fuso cobertos: carga às 00:30 BRT (vira 03:30Z), carga às 21:30 BRT
 * (vira dia seguinte em UTC), carga às 01:30 BRT (antes de "agora" em UTC e
 * depois em BRT), rótulo dd/MM/yyyy, rótulo ISO sem offset na borda do horizonte,
 * rótulo com Z (instante absoluto), rótulo inválido ("A confirmar") caindo em
 * data+horário, `horario` nulo, `data` nula, datas dos dois lados de "hoje", e
 * `approved_at` nos dois lados da meia-noite de São Paulo.
 */
const cargo = (overrides) => ({
  id: overrides.id,
  data: "2026-08-01",
  horario: "08:00:00",
  origem: "Salvador / BA",
  destino: "Campinas / SP",
  distancia_km: 1800,
  perfil: "CARRETA",
  status: "OPEN",
  is_template: false,
  created_at: overrides.created_at,
  updated_at: overrides.updated_at ?? overrides.created_at,
  sheet_data_carregamento: null,
  ...overrides,
});

export const OVERVIEW_PARITY_CARGOS = [
  // ── Cargas OPEN (ordem created_at DESC) ───────────────────────────────────
  cargo({ id: "c-open-0030", horario: "00:30:00", created_at: "2026-07-31T20:00:00.000Z" }),
  cargo({ id: "c-open-2130", horario: "21:30:00", created_at: "2026-07-31T19:00:00.000Z" }),
  cargo({ id: "c-open-past", data: "2026-07-31", horario: "08:00:00", created_at: "2026-07-31T18:00:00.000Z" }),
  cargo({ id: "c-open-far", data: "2026-08-03", horario: "08:00:00", created_at: "2026-07-31T17:00:00.000Z" }),
  cargo({ id: "c-open-sem-horario", horario: null, created_at: "2026-07-31T16:00:00.000Z" }),
  cargo({ id: "c-open-sem-data", data: null, created_at: "2026-07-31T15:00:00.000Z" }),
  cargo({
    id: "c-open-label-br",
    sheet_data_carregamento: "01/08/2026 22:30",
    created_at: "2026-07-31T14:00:00.000Z",
  }),
  cargo({
    id: "c-open-label-iso-fora",
    sheet_data_carregamento: "2026-08-01T23:30",
    created_at: "2026-07-31T13:00:00.000Z",
  }),
  cargo({
    id: "c-open-label-invalido",
    sheet_data_carregamento: "A confirmar",
    horario: "12:00:00",
    created_at: "2026-07-31T12:00:00.000Z",
  }),
  cargo({
    id: "c-open-label-z",
    sheet_data_carregamento: "2026-08-01T05:30:00Z",
    created_at: "2026-07-31T11:00:00.000Z",
  }),
  cargo({ id: "c-open-0130", horario: "01:30:00", created_at: "2026-07-31T10:30:00.000Z" }),
  // Dados obrigatórios faltando → entra na fila de atenção por si só.
  cargo({
    id: "c-open-incompleta",
    data: "2026-07-30",
    perfil: "",
    distancia_km: null,
    created_at: "2026-07-31T10:00:00.000Z",
  }),
  // ── Outros status / template ──────────────────────────────────────────────
  cargo({ id: "c-draft", status: "DRAFT", created_at: "2026-07-31T09:00:00.000Z" }),
  cargo({ id: "c-booked", status: "BOOKED", created_at: "2026-07-31T08:00:00.000Z" }),
  cargo({ id: "c-completed", status: "COMPLETED", created_at: "2026-07-31T07:00:00.000Z" }),
  cargo({ id: "c-reserved", status: "RESERVED", created_at: "2026-07-31T06:00:00.000Z" }),
  cargo({ id: "c-template", is_template: true, created_at: "2026-07-31T05:00:00.000Z" }),
  cargo({ id: "c-expired", status: "EXPIRED", created_at: "2026-07-31T04:00:00.000Z" }),
  // ── Antigas sem interesse → fila de atenção. As duas primeiras EMPATAM em
  // idade truncada (72h) de propósito: o desempate vem da ordem da consulta.
  cargo({ id: "c-open-empate-a", data: "2026-07-25", created_at: "2026-07-29T01:30:00.000Z" }),
  cargo({ id: "c-open-empate-b", data: "2026-07-25", created_at: "2026-07-29T01:10:00.000Z" }),
  cargo({ id: "c-open-antiga", data: "2026-07-25", created_at: "2026-07-28T00:00:00.000Z" }),
];

const lead = (overrides) => ({
  id: overrides.id,
  load_id: overrides.load_id,
  status: "QUEUED",
  created_at: overrides.created_at,
  queued_at: overrides.queued_at ?? null,
  approved_at: overrides.approved_at ?? null,
  whatsapp_clicked_at: overrides.whatsapp_clicked_at ?? null,
  vehicle_type: "CARRETA",
  ...overrides,
});

export const OVERVIEW_PARITY_LEADS = [
  lead({
    id: "l-queued-0030",
    load_id: "c-open-0030",
    status: "QUEUED",
    queued_at: "2026-07-31T21:00:00.000Z",
    created_at: "2026-07-31T21:00:00.000Z",
  }),
  lead({
    id: "l-approved-reserved",
    load_id: "c-reserved",
    status: "APPROVED",
    approved_at: "2026-07-31T05:00:00.000Z",
    created_at: "2026-07-31T20:30:00.000Z",
  }),
  // Carga terminal (EXPIRED) → fora da Fila, não conta como disputa ativa.
  lead({ id: "l-queued-expired", load_id: "c-expired", created_at: "2026-07-31T20:00:00.000Z" }),
  // approved_at 04:00Z = 01:00 BRT do dia SEGUINTE → NÃO é "aprovado hoje" em
  // São Paulo, mas seria se o dia fosse calculado em UTC.
  lead({
    id: "l-approved-amanha-em-sp",
    load_id: "c-booked",
    status: "APPROVED",
    approved_at: "2026-08-01T04:00:00.000Z",
    created_at: "2026-07-31T19:30:00.000Z",
  }),
  lead({ id: "l-rejeitado", load_id: "c-open-2130", status: "REJECTED", created_at: "2026-07-31T19:15:00.000Z" }),
  // 03:00Z = exatamente a meia-noite de São Paulo → dentro (>=).
  lead({
    id: "l-approved-borda-sp",
    load_id: "c-open-2130",
    status: "APPROVED",
    approved_at: "2026-07-31T03:00:00.000Z",
    created_at: "2026-07-31T19:00:00.000Z",
  }),
  // 1 ms antes da meia-noite de São Paulo → fora.
  lead({
    id: "l-approved-vespera-sp",
    load_id: "c-open-far",
    status: "APPROVED",
    approved_at: "2026-07-31T02:59:59.999Z",
    created_at: "2026-07-31T18:30:00.000Z",
  }),
];

const claim = (overrides) => ({
  id: overrides.id,
  load_id: overrides.load_id,
  status: "WAITLISTED",
  created_at: overrides.created_at,
  claimed_at: overrides.claimed_at ?? overrides.created_at,
  promoted_at: overrides.promoted_at ?? null,
  confirmed_at: overrides.confirmed_at ?? null,
  queue_position: 1,
  ...overrides,
});

export const OVERVIEW_PARITY_CLAIMS = [
  // O MAIS RECENTE de toda a fixture está aqui: se `load_claims` fosse dropada
  // da agregação, `lastUpdatedAt` regrediria — é a trava contra isso.
  claim({
    id: "k-confirmed",
    load_id: "c-open-sem-data",
    status: "CONFIRMED",
    confirmed_at: "2026-08-01T05:00:00.000Z",
    created_at: "2026-07-31T18:10:00.000Z",
  }),
  claim({ id: "k-waitlisted", load_id: "c-open-far", created_at: "2026-07-31T18:00:00.000Z" }),
  claim({ id: "k-expired", load_id: "c-open-sem-horario", status: "EXPIRED", created_at: "2026-07-31T17:30:00.000Z" }),
];

/** `ORDER BY created_at DESC LIMIT n` — a fixture não deve ter empates. */
function windowRows(rows, limit) {
  return [...rows]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
}

function toDateOrNull(value) {
  return value == null ? null : new Date(value);
}

/** `date` do Postgres visto pelo pg-mem / por um processo em UTC. */
function toSqlDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

function coalesceTs(...values) {
  for (const value of values) {
    if (value != null) return new Date(value);
  }
  return null;
}

function maxDate(dates) {
  let max = null;
  for (const date of dates) {
    if (date && (!max || date.getTime() > max.getTime())) max = date;
  }
  return max;
}

export function aggregateOverviewRowsAsSql(
  cargos,
  leads,
  claims,
  { limit = OVERVIEW_WINDOW_ROWS, now = new Date() } = {},
) {
  const cargoWindow = windowRows(cargos, limit);
  const leadWindow = windowRows(leads, limit);
  const claimWindow = windowRows(claims, limit);

  const nonTemplate = cargoWindow.filter((cargo) => !cargo.is_template);
  const filaIds = new Set(
    nonTemplate.filter((cargo) => !TERMINAL_LOAD_STATUSES.includes(cargo.status)).map((cargo) => cargo.id),
  );
  const openLoads = nonTemplate.filter((cargo) => cargo.status === "OPEN");

  const countCargos = (predicate) => nonTemplate.filter(predicate).length;

  const activeQueueLeads = leadWindow.filter(
    (lead) => filaIds.has(lead.load_id) && ACTIVE_LEAD_STATUSES.includes(lead.status),
  );
  const activeQueueClaims = claimWindow.filter(
    (claim) => filaIds.has(claim.load_id) && ACTIVE_CLAIM_STATUSES.includes(claim.status),
  );

  const { startOfToday, startOfTomorrow } = resolveSaoPauloDayBounds(now);
  const approvedToday = leadWindow.filter((lead) => {
    if (lead.approved_at == null) return false;
    const approvedAt = new Date(lead.approved_at);
    return approvedAt >= startOfToday && approvedAt < startOfTomorrow;
  }).length;

  const interestByLoadId = new Map();
  const queuedByLoadId = new Map();
  for (const lead of activeQueueLeads) {
    interestByLoadId.set(lead.load_id, (interestByLoadId.get(lead.load_id) ?? 0) + 1);
    if (lead.status === "QUEUED") {
      queuedByLoadId.set(lead.load_id, (queuedByLoadId.get(lead.load_id) ?? 0) + 1);
    }
  }
  for (const claim of activeQueueClaims) {
    interestByLoadId.set(claim.load_id, (interestByLoadId.get(claim.load_id) ?? 0) + 1);
  }

  const lastUpdatedAt = maxDate([
    ...cargoWindow.map((cargo) => coalesceTs(cargo.updated_at, cargo.created_at)),
    ...leadWindow
      .filter((lead) => ACTIVE_LEAD_STATUSES.includes(lead.status))
      .map((lead) => coalesceTs(lead.approved_at, lead.queued_at, lead.whatsapp_clicked_at, lead.created_at)),
    ...claimWindow
      .filter((claim) => ACTIVE_CLAIM_STATUSES.includes(claim.status))
      .map((claim) => coalesceTs(claim.confirmed_at, claim.promoted_at, claim.claimed_at, claim.created_at)),
  ]);

  return {
    cargoCounts: {
      activeLoads: countCargos((cargo) => cargo.status === "OPEN"),
      draftCount: countCargos((cargo) => cargo.status === "DRAFT"),
      bookedCount: countCargos((cargo) => BOOKED_LOAD_STATUSES.includes(cargo.status)),
      reservedCount: countCargos((cargo) => cargo.status === "RESERVED"),
    },
    leadCounts: {
      queueActiveLeads: activeQueueLeads.length,
      pendingApprovals: activeQueueLeads.filter((lead) => lead.status === "QUEUED").length,
      approvedToday,
    },
    lastUpdatedAt,
    openLoadRows: openLoads.map((cargo) => ({
      id: cargo.id,
      data: toSqlDate(cargo.data),
      horario: cargo.horario ?? null,
      sheet_data_carregamento: cargo.sheet_data_carregamento ?? null,
      origem: cargo.origem ?? null,
      destino: cargo.destino ?? null,
      distancia_km: cargo.distancia_km ?? null,
      perfil: cargo.perfil ?? null,
      status: cargo.status,
      created_at: toDateOrNull(cargo.created_at),
      interesse: interestByLoadId.get(cargo.id) ?? 0,
      leads_na_fila: queuedByLoadId.get(cargo.id) ?? 0,
    })),
  };
}
