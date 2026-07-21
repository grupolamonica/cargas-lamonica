import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;

function parseIsoDate(value, fallback) {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return fallback;
  // Interpret date as BRT midnight (UTC-3 = 03:00 UTC). Input dates come from the
  // frontend in local (Brazil) time, so "2026-04-27" means April 27 at 00:00 BRT.
  const parsed = new Date(`${trimmed}T03:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

// Piso "todo o período": bem anterior a qualquer dado da plataforma. Usado
// quando o operador tira o filtro de data (range=all) — a contagem passa a somar
// tudo, sem o teto de MAX_WINDOW_DAYS.
const ALL_TIME_FROM = new Date("2000-01-01T00:00:00.000Z");

export function resolveWindow(query) {
  const now = new Date();
  const defaultTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const defaultFrom = new Date(defaultTo.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

  // "Limpar" no seletor de período = sem filtro de data = TODO o período. O front
  // sinaliza com range=all; aqui abrimos a janela até ALL_TIME_FROM (ignorando o
  // teto de 365d) para que os indicadores mostrem a soma total, não os últimos 7d.
  if (String(query?.range || "").toLowerCase() === "all") {
    return { dateFrom: ALL_TIME_FROM, dateToExclusive: defaultTo, allTime: true };
  }

  const dateFrom = parseIsoDate(query?.dateFrom, defaultFrom);
  const dateToRaw = parseIsoDate(query?.dateTo, defaultTo);
  const dateToExclusive = new Date(dateToRaw.getTime() + 86_400_000);

  if (dateFrom >= dateToExclusive) {
    return { dateFrom: defaultFrom, dateToExclusive: defaultTo, allTime: false };
  }

  const spanDays = Math.round((dateToExclusive.getTime() - dateFrom.getTime()) / 86_400_000);
  if (spanDays > MAX_WINDOW_DAYS) {
    const clampedFrom = new Date(dateToExclusive.getTime() - MAX_WINDOW_DAYS * 86_400_000);
    return { dateFrom: clampedFrom, dateToExclusive, allTime: false };
  }

  return { dateFrom, dateToExclusive, allTime: false };
}

async function queryFunnel(client, dateFrom, dateTo) {
  const { rows } = await client.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE pre_registered_at >= $1 AND pre_registered_at < $2)::int AS pre_registered,
        COUNT(*) FILTER (WHERE queued_at >= $1 AND queued_at < $2)::int AS queued,
        COUNT(*) FILTER (WHERE whatsapp_clicked_at >= $1 AND whatsapp_clicked_at < $2)::int AS whatsapp_clicked,
        COUNT(*) FILTER (WHERE approved_at >= $1 AND approved_at < $2)::int AS approved,
        COUNT(*) FILTER (WHERE status = 'CANCELLED' AND pre_registered_at >= $1 AND pre_registered_at < $2)::int AS cancelled,
        AVG(EXTRACT(EPOCH FROM (whatsapp_clicked_at - pre_registered_at)))
          FILTER (WHERE whatsapp_clicked_at IS NOT NULL AND pre_registered_at >= $1 AND pre_registered_at < $2) AS avg_prereg_to_whatsapp_seconds,
        AVG(EXTRACT(EPOCH FROM (approved_at - pre_registered_at)))
          FILTER (WHERE approved_at IS NOT NULL AND pre_registered_at >= $1 AND pre_registered_at < $2) AS avg_prereg_to_approved_seconds
      FROM public.load_public_leads
    `,
    [dateFrom, dateTo],
  );

  const row = rows[0] || {};
  return {
    preRegistered: Number(row.pre_registered) || 0,
    queued: Number(row.queued) || 0,
    whatsappClicked: Number(row.whatsapp_clicked) || 0,
    approved: Number(row.approved) || 0,
    cancelled: Number(row.cancelled) || 0,
    avgPreregToWhatsappSeconds: row.avg_prereg_to_whatsapp_seconds !== null ? Number(row.avg_prereg_to_whatsapp_seconds) : null,
    avgPreregToApprovedSeconds: row.avg_prereg_to_approved_seconds !== null ? Number(row.avg_prereg_to_approved_seconds) : null,
  };
}

async function queryAccessPeaks(client, dateFrom, dateTo) {
  // EXTRACT em timestamptz opera em UTC por padrão. Operação é Brasil — convertemos
  // via `AT TIME ZONE 'America/Sao_Paulo'` para que o "pico por hora" reflita o
  // horário local do motorista (BRT/BRST), não o offset UTC.
  const [hourRows, dowRows] = await Promise.all([
    client.query(
      `
        SELECT
          EXTRACT(HOUR FROM pre_registered_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
          COUNT(*)::int AS total
        FROM public.load_public_leads
        WHERE pre_registered_at >= $1 AND pre_registered_at < $2
        GROUP BY hour
        ORDER BY hour
      `,
      [dateFrom, dateTo],
    ),
    client.query(
      `
        SELECT
          EXTRACT(DOW FROM pre_registered_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
          COUNT(*)::int AS total
        FROM public.load_public_leads
        WHERE pre_registered_at >= $1 AND pre_registered_at < $2
        GROUP BY dow
        ORDER BY dow
      `,
      [dateFrom, dateTo],
    ),
  ]);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0 }));
  for (const row of hourRows.rows) {
    const idx = Number(row.hour);
    if (idx >= 0 && idx <= 23) byHour[idx].total = Number(row.total) || 0;
  }

  const byDow = Array.from({ length: 7 }, (_, dow) => ({ dow, total: 0 }));
  for (const row of dowRows.rows) {
    const idx = Number(row.dow);
    if (idx >= 0 && idx <= 6) byDow[idx].total = Number(row.total) || 0;
  }

  return { byHour, byDow };
}

async function queryPortalVisits(client, dateFrom, dateTo) {
  const emptyResult = {
    total: 0,
    uniqueVisitors: 0,
    firstVisitAt: null,
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0 })),
    byDow: Array.from({ length: 7 }, (_, dow) => ({ dow, total: 0 })),
  };

  try {
    // Mesma lógica de timezone das outras queries de pico: BRT (UTC-3/-2).
    const [hourRows, dowRows, totalRows] = await Promise.all([
      client.query(
        `
          SELECT
            EXTRACT(HOUR FROM visited_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
            COUNT(*)::int AS total
          FROM public.driver_portal_visits
          WHERE visited_at >= $1 AND visited_at < $2
          GROUP BY hour
          ORDER BY hour
        `,
        [dateFrom, dateTo],
      ),
      client.query(
        `
          SELECT
            EXTRACT(DOW FROM visited_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
            COUNT(*)::int AS total
          FROM public.driver_portal_visits
          WHERE visited_at >= $1 AND visited_at < $2
          GROUP BY dow
          ORDER BY dow
        `,
        [dateFrom, dateTo],
      ),
      client.query(
        // total = soma de acessos (uma linha por visita); unique_visitors = IPs
        // distintos (DC-242, aprox. de "usuário único" — rede/aparelho, não pessoa).
        // COUNT(DISTINCT) ignora IPs nulos, o comportamento desejado.
        // first_visit_at = acesso mais antigo na janela; usado para a "média/dia"
        // no modo "todo o período" (senão dividiria pelo piso ALL_TIME_FROM).
        `SELECT
           COUNT(*)::int AS total,
           COUNT(DISTINCT request_ip)::int AS unique_visitors,
           MIN(visited_at) AS first_visit_at
         FROM public.driver_portal_visits
         WHERE visited_at >= $1 AND visited_at < $2`,
        [dateFrom, dateTo],
      ),
    ]);

    for (const row of hourRows.rows) {
      const idx = Number(row.hour);
      if (idx >= 0 && idx <= 23) emptyResult.byHour[idx].total = Number(row.total) || 0;
    }
    for (const row of dowRows.rows) {
      const idx = Number(row.dow);
      if (idx >= 0 && idx <= 6) emptyResult.byDow[idx].total = Number(row.total) || 0;
    }
    emptyResult.total = Number(totalRows.rows[0]?.total) || 0;
    emptyResult.uniqueVisitors = Number(totalRows.rows[0]?.unique_visitors) || 0;
    emptyResult.firstVisitAt = totalRows.rows[0]?.first_visit_at
      ? new Date(totalRows.rows[0].first_visit_at).toISOString()
      : null;

    return emptyResult;
  } catch (error) {
    const msg = (error?.message || "").toLowerCase();
    if (msg.includes("driver_portal_visits") || msg.includes("does not exist")) {
      return emptyResult;
    }
    throw error;
  }
}

export async function recordDriverPortalVisit({ requestIp, correlationId } = {}) {
  return withPgClient(async (client) => {
    try {
      await client.query(
        `INSERT INTO public.driver_portal_visits (request_ip, correlation_id) VALUES ($1, $2)`,
        [requestIp || null, correlationId || null],
      );
      return { ok: true };
    } catch (error) {
      const msg = (error?.message || "").toLowerCase();
      if (msg.includes("driver_portal_visits") || msg.includes("does not exist")) {
        logStructuredEvent("warn", "driver-portal.visit.table_missing", {
          correlationId: correlationId || null,
        });
        return { ok: false, reason: "TABLE_MISSING" };
      }
      throw error;
    }
  });
}

async function queryValidationQuality(client, dateFrom, dateTo) {
  let summaryRow = {};
  let topWarnings = [];

  try {
    const { rows } = await client.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE validation_status = 'VALID')::int AS valid,
          COUNT(*) FILTER (WHERE validation_status = 'EXPIRING')::int AS expiring,
          COUNT(*) FILTER (WHERE validation_status = 'INVALID')::int AS invalid,
          COUNT(*) FILTER (WHERE validation_status = 'NOT_FOUND')::int AS not_found,
          COUNT(*) FILTER (WHERE validation_status = 'PLATE_MISMATCH')::int AS plate_mismatch,
          COUNT(*) FILTER (WHERE validation_status IS NULL)::int AS pending,
          COUNT(*) FILTER (
            WHERE validation_summary_json IS NOT NULL
              AND (validation_summary_json->'driver'->'angelira'->>'found')::boolean = true
          )::int AS angelira_found,
          COUNT(*) FILTER (
            WHERE validation_summary_json IS NOT NULL
              AND (validation_summary_json->'driver'->'aspx'->>'found')::boolean = true
          )::int AS aspx_found
        FROM public.load_public_leads
        WHERE pre_registered_at >= $1 AND pre_registered_at < $2
      `,
      [dateFrom, dateTo],
    );
    summaryRow = rows[0] || {};
  } catch (error) {
    const msg = (error?.message || "").toLowerCase();
    if (!msg.includes("validation_status") && !msg.includes("validation_summary_json")) {
      throw error;
    }
    // Coluna ausente: retorna zeros defensivamente.
    summaryRow = {};
  }

  try {
    const { rows } = await client.query(
      `
        SELECT warning, COUNT(*)::int AS total
        FROM public.load_public_leads,
        LATERAL jsonb_array_elements_text(validation_summary_json->'warnings') AS warning
        WHERE pre_registered_at >= $1 AND pre_registered_at < $2
          AND validation_summary_json IS NOT NULL
        GROUP BY warning
        ORDER BY total DESC
        LIMIT 5
      `,
      [dateFrom, dateTo],
    );
    topWarnings = rows.map((row) => ({ warning: row.warning, total: Number(row.total) || 0 }));
  } catch (error) {
    const msg = (error?.message || "").toLowerCase();
    if (!msg.includes("validation_summary_json")) {
      throw error;
    }
    topWarnings = [];
  }

  return {
    total: Number(summaryRow.total) || 0,
    valid: Number(summaryRow.valid) || 0,
    expiring: Number(summaryRow.expiring) || 0,
    invalid: Number(summaryRow.invalid) || 0,
    notFound: Number(summaryRow.not_found) || 0,
    plateMismatch: Number(summaryRow.plate_mismatch) || 0,
    pending: Number(summaryRow.pending) || 0,
    angeliraFound: Number(summaryRow.angelira_found) || 0,
    aspxFound: Number(summaryRow.aspx_found) || 0,
    topWarnings,
  };
}

async function queryRecurrence(client, dateFrom, dateTo, allTime = false) {
  const { rows: aggregateRows } = await client.query(
    `
      WITH per_cpf AS (
        SELECT cpf, COUNT(*)::int AS candidaturas
        FROM public.load_public_leads
        WHERE pre_registered_at >= $1 AND pre_registered_at < $2
          AND cpf IS NOT NULL AND cpf <> ''
        GROUP BY cpf
      )
      SELECT
        COUNT(*)::int AS unique_cpfs,
        COALESCE(SUM(candidaturas), 0)::int AS total_candidaturas,
        COALESCE(AVG(candidaturas), 0)::numeric(10,2) AS avg_per_cpf,
        COALESCE(MAX(candidaturas), 0)::int AS max_per_cpf,
        COUNT(*) FILTER (WHERE candidaturas = 1)::int AS single_cpfs,
        COUNT(*) FILTER (WHERE candidaturas > 1)::int AS repeat_cpfs
      FROM per_cpf
    `,
    [dateFrom, dateTo],
  );

  const aggregate = aggregateRows[0] || {};

  let newDrivers;
  let recurringDrivers;
  if (allTime) {
    // "Todo o período" não tem um "antes da janela" (o piso é ALL_TIME_FROM), então
    // a definição por pré-existência degenera para 100% novos. Nesse modo, "recorrente"
    // = candidatou-se mais de uma vez (candidaturas > 1) — consistente com o Recorde
    // (maxPerCpf) e a Média por motorista mostrados no mesmo card.
    newDrivers = Number(aggregate.single_cpfs) || 0;
    recurringDrivers = Number(aggregate.repeat_cpfs) || 0;
  } else {
    // Janela delimitada: novo = CPF sem candidatura ANTES do início da janela.
    const { rows: recurrenceRows } = await client.query(
      `
        WITH window_cpfs AS (
          SELECT DISTINCT cpf
          FROM public.load_public_leads
          WHERE pre_registered_at >= $1 AND pre_registered_at < $2
            AND cpf IS NOT NULL AND cpf <> ''
        ), existing_before AS (
          SELECT DISTINCT cpf
          FROM public.load_public_leads
          WHERE pre_registered_at < $1
            AND cpf IS NOT NULL AND cpf <> ''
        )
        SELECT
          COUNT(*) FILTER (WHERE e.cpf IS NULL)::int AS new_drivers,
          COUNT(*) FILTER (WHERE e.cpf IS NOT NULL)::int AS recurring_drivers
        FROM window_cpfs w
        LEFT JOIN existing_before e ON e.cpf = w.cpf
      `,
      [dateFrom, dateTo],
    );
    const recurrence = recurrenceRows[0] || {};
    newDrivers = Number(recurrence.new_drivers) || 0;
    recurringDrivers = Number(recurrence.recurring_drivers) || 0;
  }

  return {
    uniqueCpfs: Number(aggregate.unique_cpfs) || 0,
    totalCandidaturas: Number(aggregate.total_candidaturas) || 0,
    avgPerCpf: aggregate.avg_per_cpf !== null ? Number(aggregate.avg_per_cpf) : 0,
    maxPerCpf: Number(aggregate.max_per_cpf) || 0,
    newDrivers,
    recurringDrivers,
  };
}

async function queryCadastros(client, dateFrom, dateTo) {
  // DC-243 — indicadores do sistema de Cadastro no /painel, escopados pela mesma
  // janela BRT semi-aberta [from, toExclusive) do resto do endpoint.
  // Fonte única: public.pending_driver_registrations (tabela de candidatura/cadastro).
  //  - realizados: cadastros efetivamente feitos no período (created_at), excluindo
  //    rascunhos ('draft') não submetidos. created_at é a única data confiável
  //    (reviewed_at é NULL em ~62% dos aprovados e distorcido pelo auto-approve).
  //  - pendentes: cadastros que entraram na fila de ação do operador no período
  //    (status='pendente' — mesma fonte do DC-196), por created_at para bater com
  //    o "no período selecionado" do card.
  const { rows } = await client.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND status <> 'draft')::int AS realizados,
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND status = 'pendente')::int AS pendentes
      FROM public.pending_driver_registrations
    `,
    [dateFrom, dateTo],
  );

  const row = rows[0] || {};
  return {
    realizados: Number(row.realizados) || 0,
    pendentes: Number(row.pendentes) || 0,
  };
}

async function queryPortalAvailability(client, dateFrom, dateTo) {
  // DC-244 — total de cargas DISPONIBILIZADAS no portal do motorista no período.
  // Não existe coluna de "publicado no portal", então usamos created_at como proxy
  // de "entrou no portal": a carga nasce OPEN/pública no lançamento (inclui os spots
  // automáticos do DC-201, inseridos direto como OPEN/PUBLIC). Conta mesmo as que
  // depois foram reservadas/fechadas/expiraram — o operador quer saber "quantas
  // cargas ficaram visíveis para o motorista aceitar", somadas no período. Recorte:
  // created_at na janela BRT semi-aberta [from, toExclusive) + carga publicada
  // (não-rascunho, não-template) E visível ao motorista pela MESMA regra do
  // buildDriverLoadFilters (_shared.js): avulsa (viagem_id NULL) → driver_visibility
  // 'PUBLIC'; perna de pacote (viagem_id NOT NULL) → o pacote está publicado
  // (cc.status IN publicado/reservado/em_andamento). Sem o gate por cc.status,
  // pernas de pacote em rascunho (nunca vistas pelo motorista) inflariam a conta.
  const { rows } = await client.query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE cargas.created_at >= $1 AND cargas.created_at < $2
            AND COALESCE(cargas.is_template, false) = false
            AND cargas.status <> 'DRAFT'
            AND (
              (cargas.viagem_id IS NULL AND COALESCE(cargas.driver_visibility, 'PUBLIC') = 'PUBLIC')
              OR
              (cargas.viagem_id IS NOT NULL AND cc.status IN ('publicado','reservado','em_andamento'))
            )
        )::int AS total
      FROM public.cargas
      LEFT JOIN public.cargas_casadas cc ON cc.id = cargas.viagem_id
    `,
    [dateFrom, dateTo],
  );

  const row = rows[0] || {};
  return {
    total: Number(row.total) || 0,
  };
}

export async function fetchDriverFlowMetrics({ query, correlationId }) {
  const window = resolveWindow(query);

  logStructuredEvent("info", "operator-admin.driver-flow-metrics.requested", {
    correlationId: correlationId || null,
    dateFrom: window.dateFrom.toISOString(),
    dateToExclusive: window.dateToExclusive.toISOString(),
  });

  return withPgClient(async (client) => {
    const [funnel, accessPeaks, validation, recurrence, portalVisits, cadastros, portalAvailability] = await Promise.all([
      queryFunnel(client, window.dateFrom, window.dateToExclusive),
      queryAccessPeaks(client, window.dateFrom, window.dateToExclusive),
      queryValidationQuality(client, window.dateFrom, window.dateToExclusive),
      queryRecurrence(client, window.dateFrom, window.dateToExclusive, window.allTime),
      queryPortalVisits(client, window.dateFrom, window.dateToExclusive),
      queryCadastros(client, window.dateFrom, window.dateToExclusive),
      queryPortalAvailability(client, window.dateFrom, window.dateToExclusive),
    ]);

    return {
      statusCode: 200,
      payload: {
        window: {
          from: window.dateFrom.toISOString(),
          toExclusive: window.dateToExclusive.toISOString(),
          allTime: window.allTime === true,
        },
        funnel,
        accessPeaks,
        validation,
        recurrence,
        portalVisits,
        cadastros,
        portalAvailability,
        meta: {
          correlationId: correlationId || null,
        },
      },
    };
  });
}
