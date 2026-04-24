import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;

function parseIsoDate(value, fallback) {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return fallback;
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function resolveWindow(query) {
  const now = new Date();
  const defaultTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const defaultFrom = new Date(defaultTo.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

  const dateFrom = parseIsoDate(query?.dateFrom, defaultFrom);
  const dateToRaw = parseIsoDate(query?.dateTo, defaultTo);
  const dateToExclusive = new Date(dateToRaw.getTime() + 86_400_000);

  if (dateFrom >= dateToExclusive) {
    return { dateFrom: defaultFrom, dateToExclusive: defaultTo };
  }

  const spanDays = Math.round((dateToExclusive.getTime() - dateFrom.getTime()) / 86_400_000);
  if (spanDays > MAX_WINDOW_DAYS) {
    const clampedFrom = new Date(dateToExclusive.getTime() - MAX_WINDOW_DAYS * 86_400_000);
    return { dateFrom: clampedFrom, dateToExclusive };
  }

  return { dateFrom, dateToExclusive };
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
        `SELECT COUNT(*)::int AS total FROM public.driver_portal_visits WHERE visited_at >= $1 AND visited_at < $2`,
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

async function queryRecurrence(client, dateFrom, dateTo) {
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
        COALESCE(MAX(candidaturas), 0)::int AS max_per_cpf
      FROM per_cpf
    `,
    [dateFrom, dateTo],
  );

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

  const aggregate = aggregateRows[0] || {};
  const recurrence = recurrenceRows[0] || {};

  return {
    uniqueCpfs: Number(aggregate.unique_cpfs) || 0,
    totalCandidaturas: Number(aggregate.total_candidaturas) || 0,
    avgPerCpf: aggregate.avg_per_cpf !== null ? Number(aggregate.avg_per_cpf) : 0,
    maxPerCpf: Number(aggregate.max_per_cpf) || 0,
    newDrivers: Number(recurrence.new_drivers) || 0,
    recurringDrivers: Number(recurrence.recurring_drivers) || 0,
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
    const [funnel, accessPeaks, validation, recurrence, portalVisits] = await Promise.all([
      queryFunnel(client, window.dateFrom, window.dateToExclusive),
      queryAccessPeaks(client, window.dateFrom, window.dateToExclusive),
      queryValidationQuality(client, window.dateFrom, window.dateToExclusive),
      queryRecurrence(client, window.dateFrom, window.dateToExclusive),
      queryPortalVisits(client, window.dateFrom, window.dateToExclusive),
    ]);

    return {
      statusCode: 200,
      payload: {
        window: {
          from: window.dateFrom.toISOString(),
          toExclusive: window.dateToExclusive.toISOString(),
        },
        funnel,
        accessPeaks,
        validation,
        recurrence,
        portalVisits,
        meta: {
          correlationId: correlationId || null,
        },
      },
    };
  });
}
