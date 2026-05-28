import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";
import { recordDriverValidationIntegrationResult } from "../metrics.js";
import { createSupabaseAdminClient } from "../supabase/admin-client.js";

// Fonte de verdade: tabela public.aspx_drivers (populada pelo job
// scripts/aspx-sync/asp.py a cada 1h via GitHub Action). Presença no
// registro significa "tem ASPx = SIM". Assinatura pública e forma de retorno
// preservadas: lookupAspxDriverByCpf -> { availability, status, found,
// displayName }. Consumido por public-lead-validation.js no momento da
// candidatura do motorista.

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const FETCH_PAGE_SIZE = 1000;
// Operational alert threshold: quando o registro mais recente em aspx_drivers
// passa de 6h, logamos um warning estruturado pra observability — sinaliza
// que o sync container parou. Iter #10.
const STALE_CACHE_WARNING_SECONDS = 6 * 60 * 60;

let directoryCache = {
  byCpf: null,
  expiresAt: 0,
};

let inFlightDirectoryRequest = null;
let supabaseClientOverride = null;

const circuitState = {
  failures: 0,
  openUntil: 0,
};

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getCacheTtlMs() {
  return parsePositiveIntegerEnv("ASPX_DIRECTORY_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_MS / 1_000) * 1_000;
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("ASPX_DIRECTORY_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("ASPX_DIRECTORY_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_MS / 1_000) * 1_000;
}

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function markFailure(error, context = {}) {
  circuitState.failures += 1;

  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }

  logStructuredEvent("warn", "driver-validation.aspx.failure", {
    correlationId: context.correlationId || null,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
    message: error instanceof Error ? error.message : String(error),
  });
}

function markSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function getSupabaseClient() {
  if (supabaseClientOverride) {
    return supabaseClientOverride;
  }
  return createSupabaseAdminClient();
}

async function fetchAllAspxDrivers(client) {
  const rows = [];
  let offset = 0;
  let maxSyncedAtMs = null;

  // Paginação manual: a tabela pode passar de ~1000 registros.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await client
      .from("aspx_drivers")
      .select("cpf, display_name, synced_at")
      .range(offset, offset + FETCH_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`ASPX_DIRECTORY_FETCH_FAILED:${error.code || error.message}`);
    }

    const batch = data || [];
    for (const row of batch) {
      rows.push(row);
      if (row?.synced_at) {
        const tsMs = new Date(row.synced_at).getTime();
        if (Number.isFinite(tsMs) && (maxSyncedAtMs === null || tsMs > maxSyncedAtMs)) {
          maxSyncedAtMs = tsMs;
        }
      }
    }

    if (batch.length < FETCH_PAGE_SIZE) {
      break;
    }

    offset += FETCH_PAGE_SIZE;
  }

  return { rows, maxSyncedAtMs };
}

function buildDirectoryIndex(rows) {
  const directoryByCpf = new Map();

  for (const row of rows) {
    const normalizedCpf = normalizeCpf(row?.cpf);
    if (!normalizedCpf) {
      continue;
    }

    const displayName = typeof row?.display_name === "string" ? row.display_name.trim() : "";

    directoryByCpf.set(normalizedCpf, {
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: displayName || null,
    });
  }

  return directoryByCpf;
}

async function loadDirectoryIndex({ correlationId } = {}) {
  if (directoryCache.byCpf && directoryCache.expiresAt > Date.now()) {
    return directoryCache.byCpf;
  }

  if (isCircuitOpen()) {
    throw new Error("ASPX_DIRECTORY_CIRCUIT_OPEN");
  }

  if (inFlightDirectoryRequest) {
    return inFlightDirectoryRequest;
  }

  const requestPromise = (async () => {
    const startedAt = Date.now();

    try {
      const client = getSupabaseClient();
      const { rows, maxSyncedAtMs } = await fetchAllAspxDrivers(client);
      const directoryByCpf = buildDirectoryIndex(rows);

      directoryCache = {
        byCpf: directoryByCpf,
        expiresAt: Date.now() + getCacheTtlMs(),
      };

      markSuccess();

      logStructuredEvent("info", "driver-validation.aspx.lookup_completed", {
        correlationId: correlationId || null,
        rowCount: directoryByCpf.size,
        latencyMs: Date.now() - startedAt,
      });
      recordDriverValidationIntegrationResult("aspx", {
        availability: "OK",
        latencyMs: Date.now() - startedAt,
      });

      // Iter #10: alerta operacional. Quando o sync container para de rodar,
      // o cache passa a servir dados velhos e motoristas recem-cadastrados no
      // portal Angellira ficam invisiveis para a candidatura. Detectamos via
      // idade do registro mais recente em aspx_drivers.
      if (maxSyncedAtMs !== null) {
        const ageSeconds = Math.max(0, Math.floor((Date.now() - maxSyncedAtMs) / 1000));
        if (ageSeconds > STALE_CACHE_WARNING_SECONDS) {
          logStructuredEvent("warn", "driver-validation.aspx.stale_cache", {
            correlationId: correlationId || null,
            ageSeconds,
            ageHours: Math.round(ageSeconds / 3600),
            driverCount: directoryByCpf.size,
            mostRecentSyncedAt: new Date(maxSyncedAtMs).toISOString(),
            thresholdSeconds: STALE_CACHE_WARNING_SECONDS,
          });
        }
      }

      return directoryByCpf;
    } catch (error) {
      recordDriverValidationIntegrationResult("aspx", {
        availability: "UNAVAILABLE",
        latencyMs: Date.now() - startedAt,
      });
      markFailure(error, {
        correlationId,
      });
      throw error;
    } finally {
      inFlightDirectoryRequest = null;
    }
  })();

  inFlightDirectoryRequest = requestPromise;
  return requestPromise;
}

export async function lookupAspxDriverByCpf(cpf, { correlationId } = {}) {
  const normalizedCpf = normalizeCpf(cpf);

  if (!normalizedCpf) {
    return {
      availability: "OK",
      status: "NOT_FOUND",
      found: false,
      displayName: null,
    };
  }

  try {
    const directoryByCpf = await loadDirectoryIndex({
      correlationId,
    });

    const matchedRecord = directoryByCpf.get(normalizedCpf);

    if (!matchedRecord) {
      return {
        availability: "OK",
        status: "NOT_FOUND",
        found: false,
        displayName: null,
      };
    }

    return matchedRecord;
  } catch (error) {
    return {
      availability: "UNAVAILABLE",
      status: "UNAVAILABLE",
      found: false,
      displayName: null,
      errorCode: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resetAspxDirectoryStateForTests({ supabaseClient = null } = {}) {
  directoryCache = {
    byCpf: null,
    expiresAt: 0,
  };
  inFlightDirectoryRequest = null;
  circuitState.failures = 0;
  circuitState.openUntil = 0;
  supabaseClientOverride = supabaseClient;
}
