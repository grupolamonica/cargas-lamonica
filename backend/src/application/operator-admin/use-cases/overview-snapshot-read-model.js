/**
 * Painel do operador (/painel) — read model do snapshot (GET /api/operator/overview/snapshot).
 *
 * ANTES: a tela fazia 3x `select(500)` direto no PostgREST (cargas +
 * load_public_leads + load_claims, ~1500 linhas / ~0,5 MB) e agregava tudo no
 * navegador. Cada aba de operador aberta pagava o payload inteiro, e o cache do
 * React Query é por aba.
 *
 * AGORA: a agregação acontece no SQL. Voltam 3 linhas escalares (contagens +
 * MAX de atividade) mais a projeção enxuta das cargas ABERTAS (as únicas que
 * ainda precisam de linha a linha, porque "saídas nas próximas 24h", "sem
 * motorista" e a fila de atenção dependem de campos por carga). `load_claims`
 * CONTINUA na conta — ela alimenta o interesse por carga (`loadInterestById`) e o
 * MAX de atividade; o comentário do front que diz "tabela vazia em prod" não é
 * garantia de schema.
 *
 * A janela de 500 linhas por tabela é preservada de propósito: o snapshot antigo
 * contava sobre as 500 mais recentes de cada tabela, e mudar isso mudaria os
 * números da tela (não seria mais behavior-preserving).
 */
import { withPgClient } from "../../../infrastructure/pg/postgres.js";

import {
  ACTIVE_CLAIM_STATUSES,
  ACTIVE_LEAD_STATUSES,
  BOOKED_LOAD_STATUSES,
  OVERVIEW_WINDOW_ROWS,
  TERMINAL_LOAD_STATUSES,
  buildOverviewSnapshotFromAggregates,
  resolveSaoPauloDayBounds,
} from "./overview-snapshot-metrics.js";

// ⚠ `COUNT(*) FILTER (WHERE ...)` NÃO pode ser usado aqui: o pg-mem 3.x aceita a
// sintaxe e IGNORA o filtro (devolve o COUNT total em todo ramo), então um teste
// com FILTER passaria com números errados — ou mascararia regressão real.
// `COUNT(CASE WHEN ... THEN 1 END)` é idêntico no Postgres e correto no pg-mem.
// Também evitado: subquery escalar na lista do SELECT (o pg-mem devolve `[n]`
// em vez de `n`), `data::text` e `data + horario` (não implementados).

const CARGO_COUNTS_SQL = `
  WITH janela AS (
    SELECT status, COALESCE(is_template, false) AS is_template
    FROM public.cargas
    ORDER BY created_at DESC
    LIMIT $1
  )
  SELECT
    COUNT(CASE WHEN is_template = false AND status = 'OPEN' THEN 1 END)::int              AS active_loads,
    COUNT(CASE WHEN is_template = false AND status = 'DRAFT' THEN 1 END)::int             AS draft_count,
    COUNT(CASE WHEN is_template = false AND status = ANY($2::text[]) THEN 1 END)::int     AS booked_count,
    COUNT(CASE WHEN is_template = false AND status = 'RESERVED' THEN 1 END)::int          AS reserved_count
  FROM janela
`;

const LEAD_COUNTS_SQL = `
  WITH cargas_janela AS (
    SELECT id, status, COALESCE(is_template, false) AS is_template
    FROM public.cargas
    ORDER BY created_at DESC
    LIMIT $1
  ),
  fila AS (
    SELECT id FROM cargas_janela
    WHERE is_template = false AND NOT (status = ANY($2::text[]))
  ),
  leads_janela AS (
    SELECT load_id, status, approved_at
    FROM public.load_public_leads
    ORDER BY created_at DESC
    LIMIT $1
  )
  SELECT
    COUNT(CASE WHEN fila.id IS NOT NULL AND leads_janela.status = ANY($3::text[]) THEN 1 END)::int AS queue_active_leads,
    COUNT(CASE WHEN fila.id IS NOT NULL AND leads_janela.status = 'QUEUED' THEN 1 END)::int        AS pending_approvals,
    COUNT(CASE WHEN leads_janela.approved_at >= $4 AND leads_janela.approved_at < $5 THEN 1 END)::int AS approved_today
  FROM leads_janela
  LEFT JOIN fila ON fila.id = leads_janela.load_id
`;

// MAX da "última atividade" nas 3 janelas. Espelha as cadeias de COALESCE do
// front (`updated_at || created_at`, `approved_at || queued_at || ...`) e o
// recorte: cargas INTEIRAS (inclusive templates), leads/claims só os ATIVOS.
const LAST_ACTIVITY_SQL = `
  WITH cargas_janela AS (
    SELECT created_at, updated_at FROM public.cargas ORDER BY created_at DESC LIMIT $1
  ),
  leads_janela AS (
    SELECT status, created_at, queued_at, approved_at, whatsapp_clicked_at
    FROM public.load_public_leads ORDER BY created_at DESC LIMIT $1
  ),
  claims_janela AS (
    SELECT status, created_at, claimed_at, promoted_at, confirmed_at
    FROM public.load_claims ORDER BY created_at DESC LIMIT $1
  )
  SELECT MAX(ts) AS last_updated_at FROM (
    SELECT COALESCE(updated_at, created_at) AS ts FROM cargas_janela
    UNION ALL
    SELECT COALESCE(approved_at, queued_at, whatsapp_clicked_at, created_at)
    FROM leads_janela WHERE status = ANY($2::text[])
    UNION ALL
    SELECT COALESCE(confirmed_at, promoted_at, claimed_at, created_at)
    FROM claims_janela WHERE status = ANY($3::text[])
  ) atividade
`;

// Cargas ABERTAS da janela + interesse por carga. `ORDER BY created_at DESC`
// reproduz a ordem em que o front recebia as linhas — a fila de atenção ordena
// por idade com `sort` ESTÁVEL, então empates de idade dependem dessa ordem.
const OPEN_LOADS_SQL = `
  WITH cargas_janela AS (
    SELECT id, data, horario, sheet_data_carregamento, origem, destino, distancia_km,
           perfil, status, COALESCE(is_template, false) AS is_template, created_at
    FROM public.cargas
    ORDER BY created_at DESC
    LIMIT $1
  ),
  fila AS (
    SELECT id FROM cargas_janela
    WHERE is_template = false AND NOT (status = ANY($2::text[]))
  ),
  abertas AS (
    SELECT * FROM cargas_janela WHERE is_template = false AND status = 'OPEN'
  ),
  leads_janela AS (
    SELECT load_id, status FROM public.load_public_leads ORDER BY created_at DESC LIMIT $1
  ),
  claims_janela AS (
    SELECT load_id, status FROM public.load_claims ORDER BY created_at DESC LIMIT $1
  ),
  interesse_leads AS (
    SELECT leads_janela.load_id,
           COUNT(*)::int AS total,
           COUNT(CASE WHEN leads_janela.status = 'QUEUED' THEN 1 END)::int AS na_fila
    FROM leads_janela
    JOIN fila ON fila.id = leads_janela.load_id
    WHERE leads_janela.status = ANY($3::text[])
    GROUP BY leads_janela.load_id
  ),
  interesse_claims AS (
    SELECT claims_janela.load_id, COUNT(*)::int AS total
    FROM claims_janela
    JOIN fila ON fila.id = claims_janela.load_id
    WHERE claims_janela.status = ANY($4::text[])
    GROUP BY claims_janela.load_id
  )
  SELECT abertas.id, abertas.data, abertas.horario, abertas.sheet_data_carregamento,
         abertas.origem, abertas.destino, abertas.distancia_km, abertas.perfil,
         abertas.status, abertas.created_at,
         (COALESCE(interesse_leads.total, 0) + COALESCE(interesse_claims.total, 0))::int AS interesse,
         COALESCE(interesse_leads.na_fila, 0)::int AS leads_na_fila
  FROM abertas
  LEFT JOIN interesse_leads ON interesse_leads.load_id = abertas.id
  LEFT JOIN interesse_claims ON interesse_claims.load_id = abertas.id
  ORDER BY abertas.created_at DESC
`;

async function queryOverviewSnapshot({ now }) {
  const { startOfToday, startOfTomorrow } = resolveSaoPauloDayBounds(now);

  return withPgClient(async (client) => {
    const cargoCountsResult = await client.query(CARGO_COUNTS_SQL, [
      OVERVIEW_WINDOW_ROWS,
      BOOKED_LOAD_STATUSES,
    ]);
    const leadCountsResult = await client.query(LEAD_COUNTS_SQL, [
      OVERVIEW_WINDOW_ROWS,
      TERMINAL_LOAD_STATUSES,
      ACTIVE_LEAD_STATUSES,
      startOfToday.toISOString(),
      startOfTomorrow.toISOString(),
    ]);
    const lastActivityResult = await client.query(LAST_ACTIVITY_SQL, [
      OVERVIEW_WINDOW_ROWS,
      ACTIVE_LEAD_STATUSES,
      ACTIVE_CLAIM_STATUSES,
    ]);
    const openLoadsResult = await client.query(OPEN_LOADS_SQL, [
      OVERVIEW_WINDOW_ROWS,
      TERMINAL_LOAD_STATUSES,
      ACTIVE_LEAD_STATUSES,
      ACTIVE_CLAIM_STATUSES,
    ]);

    const cargoRow = cargoCountsResult.rows[0] ?? {};
    const leadRow = leadCountsResult.rows[0] ?? {};

    return {
      cargoCounts: {
        activeLoads: Number(cargoRow.active_loads ?? 0),
        draftCount: Number(cargoRow.draft_count ?? 0),
        bookedCount: Number(cargoRow.booked_count ?? 0),
        reservedCount: Number(cargoRow.reserved_count ?? 0),
      },
      leadCounts: {
        queueActiveLeads: Number(leadRow.queue_active_leads ?? 0),
        pendingApprovals: Number(leadRow.pending_approvals ?? 0),
        approvedToday: Number(leadRow.approved_today ?? 0),
      },
      lastUpdatedAt: lastActivityResult.rows[0]?.last_updated_at ?? null,
      openLoadRows: openLoadsResult.rows,
    };
  });
}

/**
 * Agregados crus do SQL (sem cache) — exposto para o teste de paridade poder
 * comparar SQL x oráculo sem passar pela montagem final.
 */
export async function fetchOverviewSnapshotAggregates({ now = new Date() } = {}) {
  return queryOverviewSnapshot({ now });
}

// ── Cache + single-flight do snapshot do Painel ──────────────────────────────
// O snapshot NÃO tem eixo de identidade: a consulta não filtra por operador nem
// por tenant — é o estado operacional global (mesmos números para todo mundo que
// abre /painel). Logo a chave é única, e o hit rate com N abas abertas é ~100%.
//
// TTL default 10s, não 30s, DE PROPÓSITO. O ganho de egress vem de colapsar
// leituras SIMULTÂNEAS (N abas abrindo, e principalmente a rajada do realtime de
// leads/claims: o debounce do front é de 1,5s, então todas as abas revalidam
// praticamente no mesmo instante). 10s já colapsa essa rajada inteira. Um TTL
// maior começaria a comer a garantia de propagação que a tela tem hoje para
// leads/claims (~1,5s via realtime): o pior caso passa a ser 1,5s + TTL, então o
// TTL É o teto de atraso que se está aceitando. 10s é o menor valor que ainda
// colapsa a rajada.
//
// 0 em teste (VITEST) p/ não vazar estado entre casos, com override explícito por
// env vencendo o guard (é assim que o teste de cache/single-flight liga o TTL).
let _overviewSnapshotInFlight = null;
let _overviewSnapshotCache = { at: 0, payload: null };

function getOverviewSnapshotCacheTtlMs() {
  const raw = Number.parseInt(process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return 10_000; // default produção
}

/** Hook de teste: zera o estado de módulo. */
export function __resetOverviewSnapshotCache() {
  _overviewSnapshotInFlight = null;
  _overviewSnapshotCache = { at: 0, payload: null };
}

async function buildSnapshotPayload({ now }) {
  const aggregates = await queryOverviewSnapshot({ now });
  return { snapshot: buildOverviewSnapshotFromAggregates(aggregates, now) };
}

export async function fetchOperatorOverviewSnapshot({ correlationId, now = new Date() } = {}) {
  const ttl = getOverviewSnapshotCacheTtlMs();
  if (ttl <= 0) {
    const payload = await buildSnapshotPayload({ now });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  }

  const startedAt = Date.now();
  if (_overviewSnapshotCache.payload && startedAt - _overviewSnapshotCache.at < ttl) {
    return {
      statusCode: 200,
      payload: { ..._overviewSnapshotCache.payload, meta: { correlationId, cached: true } },
    };
  }

  if (_overviewSnapshotInFlight) {
    const shared = await _overviewSnapshotInFlight;
    return { statusCode: 200, payload: { ...shared, meta: { correlationId, cached: true } } };
  }

  const promise = (async () => {
    const payload = await buildSnapshotPayload({ now });
    // Só cacheia resultado bem-sucedido (erro estoura antes desta linha).
    _overviewSnapshotCache = { at: Date.now(), payload };
    return payload;
  })();
  _overviewSnapshotInFlight = promise;

  try {
    const payload = await promise;
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } finally {
    _overviewSnapshotInFlight = null;
  }
}
