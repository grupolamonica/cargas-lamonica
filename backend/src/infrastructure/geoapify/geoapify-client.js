import { ConfigurationError, TimeoutError, UpstreamApiError } from "./errors.js";
import { logger } from "../logger.js";

const GEOAPIFY_BASE_URL = "https://api.geoapify.com";
const DEFAULT_TIMEOUT_MS = 5000;

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

const circuitState = {
  failures: 0,
  openUntil: 0,
};

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function recordCircuitFailure() {
  circuitState.failures += 1;
  if (circuitState.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitState.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

function recordCircuitSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

function getApiKey() {
  const apiKey = process.env.GEOAPIFY_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    throw new ConfigurationError("Missing GEOAPIFY_API_KEY environment variable.", {
      operation: "configuration",
    });
  }

  return apiKey.trim();
}

function buildUrl(pathname, params = {}) {
  const url = new URL(pathname, GEOAPIFY_BASE_URL);

  Object.entries({ ...params, apiKey: getApiKey() }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url;
}

function normalizeProviderErrorBody(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === "string") {
    return payload.slice(0, 300);
  }

  const candidate =
    payload.error ||
    payload.message ||
    payload.reason ||
    payload.description ||
    payload.hint ||
    payload;

  try {
    return JSON.stringify(candidate).slice(0, 300);
  } catch {
    return String(candidate).slice(0, 300);
  }
}

function logGeoapifyError(operation, error, context = {}) {
  const payload = {
    operation,
    status: error?.status ?? null,
    code: error?.code ?? null,
    origin: context.origin ?? null,
    destination: context.destination ?? null,
    location: context.location ?? null,
    message: error?.message ?? "Unknown Geoapify error",
    providerBody: error?.details?.providerBody ?? null,
  };

  logger.error(payload, "geoapify error");
}

async function parseJsonResponse(response, operation, context) {
  try {
    return await response.json();
  } catch (error) {
    const wrappedError = new UpstreamApiError("Geoapify returned an invalid JSON payload.", {
      operation,
      status: response.status,
      details: { ...context, providerBody: null },
      cause: error,
    });

    logGeoapifyError(operation, wrappedError, context);
    throw wrappedError;
  }
}

async function fetchWithTimeout(url, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...extraHeaders },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TimeoutError(`Geoapify request timed out after ${timeoutMs}ms.`, {
        code: "GEOAPIFY_TIMEOUT",
        cause: error,
      });
    }

    throw new UpstreamApiError("Failed to reach Geoapify.", {
      code: "GEOAPIFY_NETWORK_ERROR",
      cause: error,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const GEOAPIFY_MAX_ATTEMPTS = 3;
const GEOAPIFY_BASE_DELAY_MS = 300;

export async function getGeoapifyJson(pathname, params, options = {}) {
  const { operation = "geoapify_request", timeoutMs = DEFAULT_TIMEOUT_MS, context = {}, correlationId } = options;
  const extraHeaders = correlationId ? { "X-Correlation-Id": correlationId } : {};

  if (isCircuitOpen()) {
    const circuitError = new UpstreamApiError("Geoapify circuit breaker is open — skipping request.", {
      operation,
      code: "GEOAPIFY_CIRCUIT_OPEN",
      details: context,
    });
    logGeoapifyError(operation, circuitError, context);
    throw circuitError;
  }

  const url = buildUrl(pathname, params);

  let lastError = null;

  for (let attempt = 1; attempt <= GEOAPIFY_MAX_ATTEMPTS; attempt++) {
    let response;

    try {
      response = await fetchWithTimeout(url, timeoutMs, extraHeaders);
    } catch (error) {
      error.operation = error.operation ?? operation;
      error.details = { ...(error.details ?? {}), ...context };
      lastError = error;

      if (attempt < GEOAPIFY_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, GEOAPIFY_BASE_DELAY_MS * attempt));
        continue;
      }

      logGeoapifyError(operation, error, context);
      throw error;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < GEOAPIFY_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, GEOAPIFY_BASE_DELAY_MS * attempt));
        continue;
      }
    }

    const payload = await parseJsonResponse(response, operation, context);

    if (!response.ok) {
      const wrappedError = new UpstreamApiError(`Geoapify ${operation} request failed.`, {
        operation,
        status: response.status,
        details: {
          ...context,
          providerBody: normalizeProviderErrorBody(payload),
        },
      });

      recordCircuitFailure();
      logGeoapifyError(operation, wrappedError, context);
      throw wrappedError;
    }

    recordCircuitSuccess();
    return payload;
  }

  if (lastError) {
    recordCircuitFailure();
    logGeoapifyError(operation, lastError, context);
    throw lastError;
  }
}

export { DEFAULT_TIMEOUT_MS };
