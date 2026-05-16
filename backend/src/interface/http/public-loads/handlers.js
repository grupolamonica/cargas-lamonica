import "../../../infrastructure/config/load-env.js";

import {
  createSupabaseAdminClient,
  syncGoogleSheetLoads,
} from "../../../application/google-sheets/google-sheet-loads.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import { buildInternalErrorResponse, buildValidationErrorResponse } from "../error-mapping.js";
import { getCorrelationId, getQueryParam, getRequestIp } from "../http-utils.js";
import {
  fetchDriverLoadFacets,
  fetchDriverLoadsReadModel,
  getHealthSnapshot,
} from "../../../application/operator-admin/service.js";
import { recordDriverPortalVisit } from "../../../domain/operator-admin/driver-flow-metrics.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";

const PORTAL_VISIT_RATE_LIMIT_MS = 30_000;
const portalVisitRateLimitByIp = new Map();

// MD-02: cleanup periódico para evitar crescimento ilimitado com IPs dinâmicos (CGNAT/mobile)
setInterval(() => {
  const cutoff = Date.now() - PORTAL_VISIT_RATE_LIMIT_MS;
  for (const [key, value] of portalVisitRateLimitByIp) {
    if (value < cutoff) portalVisitRateLimitByIp.delete(key);
  }
}, 60_000).unref();

function isPortalVisitRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const lastSeen = portalVisitRateLimitByIp.get(ip);
  if (lastSeen && now - lastSeen < PORTAL_VISIT_RATE_LIMIT_MS) {
    return true;
  }
  portalVisitRateLimitByIp.set(ip, now);
  if (portalVisitRateLimitByIp.size > 5000) {
    const cutoff = now - PORTAL_VISIT_RATE_LIMIT_MS;
    for (const [key, value] of portalVisitRateLimitByIp) {
      if (value < cutoff) portalVisitRateLimitByIp.delete(key);
    }
  }
  return false;
}

const DRIVER_LOADS_SHEET_STALE_AFTER_MS = Math.max(
  Number.parseInt(process.env.PUBLIC_DRIVER_LOADS_SHEET_STALE_AFTER_MS || "", 10) || 7 * 60_000,
  60_000,
);
const DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS = Math.max(
  Number.parseInt(process.env.PUBLIC_DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS || "", 10) || 45_000,
  15_000,
);

let driverLoadsSheetRefreshPromise = null;
let lastDriverLoadsSheetRefreshCheckAt = 0;

function toErrorResponse(error, correlationId) {
  if (error instanceof ValidationError) {
    return buildValidationErrorResponse(error, correlationId);
  }
  return buildInternalErrorResponse(
    correlationId,
    "Unexpected error while processing the public load request.",
  );
}

function hasAutomaticDriverLoadsSheetRefreshSupport() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();

  return Boolean(supabaseUrl && serviceRoleKey);
}

function parseSheetSyncTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsedTimestamp = new Date(value);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp;
}

async function fetchLatestSheetSyncTimestamp(supabaseClient) {
  const { data, error } = await supabaseClient
    .from("cargas")
    .select("sheet_synced_at")
    .not("sheet_lh", "is", null)
    .order("sheet_synced_at", { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  return parseSheetSyncTimestamp(data?.[0]?.sheet_synced_at);
}

async function ensureDriverLoadsSheetFresh({
  now = Date.now(),
  createClient = createSupabaseAdminClient,
  syncLoads = syncGoogleSheetLoads,
} = {}) {
  if (!hasAutomaticDriverLoadsSheetRefreshSupport()) {
    return false;
  }

  if (driverLoadsSheetRefreshPromise) {
    await driverLoadsSheetRefreshPromise;
    return true;
  }

  if (now - lastDriverLoadsSheetRefreshCheckAt < DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS) {
    return false;
  }

  lastDriverLoadsSheetRefreshCheckAt = now;

  try {
    const supabaseClient = createClient();
    const latestSheetSyncTimestamp = await fetchLatestSheetSyncTimestamp(supabaseClient);

    if (
      latestSheetSyncTimestamp &&
      now - latestSheetSyncTimestamp.getTime() < DRIVER_LOADS_SHEET_STALE_AFTER_MS
    ) {
      return false;
    }

    // CR-01: captura a promise em variável local antes do .finally zerá-la,
    // evitando race condition onde uma request subsequente vê null e dispara sync duplo.
    const syncPromise = Promise.resolve(
      syncLoads({
        supabaseClient,
      }),
    )
      .catch((error) => {
        console.error("[driver-loads-sheet-sync]", {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        });
      })
      .finally(() => {
        driverLoadsSheetRefreshPromise = null;
        lastDriverLoadsSheetRefreshCheckAt = Date.now();
      });

    driverLoadsSheetRefreshPromise = syncPromise;
    await syncPromise;
    return true;
  } catch (error) {
    console.error("[driver-loads-sheet-sync-check]", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    return false;
  }
}

export function resetDriverLoadsSheetRefreshStateForTests() {
  driverLoadsSheetRefreshPromise = null;
  lastDriverLoadsSheetRefreshCheckAt = 0;
}

export async function resolveDriverLoadsReadModelResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await ensureDriverLoadsSheetFresh();

    return await fetchDriverLoadsReadModel({
      query: request.query || {},
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDriverLoadFacetsResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    return await fetchDriverLoadFacets({
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDriverPortalVisitResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isPortalVisitRateLimited(requestIp)) {
    return {
      statusCode: 200,
      payload: { ok: true, rateLimited: true, meta: { correlationId } },
    };
  }

  try {
    await recordDriverPortalVisit({ requestIp, correlationId });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  } catch (err) {
    console.error("[portal-visit] falha ao registrar visita:", err?.message);
    return {
      statusCode: 200,
      payload: { ok: false, meta: { correlationId } },
    };
  }
}

export async function resolveHealthResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const deep = getQueryParam(request, "deep") === "true";
    return await getHealthSnapshot({
      correlationId,
      deep,
    });
  } catch (error) {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: "ServiceUnavailable",
        code: "SERVICE_UNAVAILABLE",
        message: "Healthcheck failed.",
        meta: {
          correlationId,
        },
      },
    };
  }
}

export async function resolveDriverSponsorClickResponse(request) {
  const correlationId = getCorrelationId(request);
  const brand = request.body?.brand;

  if (!brand || typeof brand !== "string") {
    return { statusCode: 400, payload: { error: "MISSING_BRAND", meta: { correlationId } } };
  }

  try {
    await withPgClient(async (client) => {
      await client.query(
        "INSERT INTO public.analytics_events (event_type, data) VALUES ($1, $2)",
        ["SPONSOR_CLICK", JSON.stringify({ brand: brand.slice(0, 120) })],
      );
    });
    return { statusCode: 200, payload: { ok: true, meta: { correlationId } } };
  } catch {
    // fire-and-forget: don't fail the request if analytics write fails
    return { statusCode: 200, payload: { ok: false, meta: { correlationId } } };
  }
}

// Cheap "did anything change?" probe for the public driver portal.
// Returns a digest based on MAX(updated_at) + count of OPEN PUBLIC cargas.
// Frontend polls every 5 min — when digest changes, invalidates the
// /api/driver/loads-read-model query. No auth: matches /api/driver/loads.
export async function resolveDriverLoadsDigestResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const digest = await withPgClient(async (client) => {
      // Cruza com a planilha (sheet_motorista/sheet_status) para que o digest
      // não conte cargas já alocadas no Google Sheets — caso o sync atrase,
      // o frontend não dispara invalidação para cargas que já estão fechadas.
      const { rows } = await client.query(`
        SELECT
          COALESCE(EXTRACT(EPOCH FROM MAX(updated_at))::bigint, 0) AS ts,
          COUNT(*)::bigint                                          AS cnt
        FROM public.cargas
        WHERE status = 'OPEN'
          AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'
          AND COALESCE(is_template, false) = false
          AND COALESCE(sheet_motorista, '') = ''
          AND COALESCE(sheet_status, '') = ''
      `);
      const r = rows[0] || {};
      return `${r.ts}:${r.cnt}`;
    });

    return {
      statusCode: 200,
      payload: { digest, meta: { correlationId } },
    };
  } catch (err) {
    console.error("[driver-loads-digest] erro ao calcular digest:", err?.message);
    return {
      statusCode: 503,
      payload: { error: "SERVICE_UNAVAILABLE", meta: { correlationId } },
    };
  }
}
