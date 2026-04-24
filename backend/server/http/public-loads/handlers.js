import "../../config/load-env.js";

import {
  createSupabaseAdminClient,
  syncGoogleSheetLoads,
} from "../../services/google-sheet-loads.js";
import { ValidationError } from "../../services/load-claims/errors.js";
import { getCorrelationId, getQueryParam, getRequestIp } from "../http-utils.js";
import {
  fetchDriverLoadFacets,
  fetchDriverLoadsReadModel,
  getHealthSnapshot,
} from "../../services/operator-admin/service.js";
import { recordDriverPortalVisit } from "../../services/operator-admin/driver-flow-metrics.js";

const PORTAL_VISIT_RATE_LIMIT_MS = 30_000;
const portalVisitRateLimitByIp = new Map();

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
    return {
      statusCode: 400,
      payload: {
        error: error.name,
        code: error.code,
        message: error.message,
        meta: { correlationId },
      },
    };
  }

  return {
    statusCode: 500,
    payload: {
      error: "InternalServerError",
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected error while processing the public load request.",
      meta: { correlationId },
    },
  };
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

    driverLoadsSheetRefreshPromise = Promise.resolve(
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

    await driverLoadsSheetRefreshPromise;
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
  } catch {
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
