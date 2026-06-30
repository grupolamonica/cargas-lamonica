import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

// Cliente HTTP fino para o servico BRK (Brasil Risk). A plataforma e apenas
// CLIENTE deste endpoint (o robo BRK roda noutra maquina e ja faz toda a
// logica de sessao/scraping/cache). Aqui fazemos somente um GET autenticado
// por X-API-Key e tratamos indisponibilidade de forma defensiva.
//
//   GET {BRK_BASE_URL}/api/brk/consultar?cpf=<11dig>&placa=<cavalo>&placa=<carreta>
//   Header: X-API-Key: <BRK_API_KEY>
//
// Espelha o circuit breaker do angellira-client (failures/openUntil/cooldown),
// mas e MUITO mais simples — sem token, sem refresh, sem login.

const DEFAULT_TIMEOUT_MS = 40_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

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

function getTimeoutMs() {
  return parsePositiveIntegerEnv("BRK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("BRK_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("BRK_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_MS / 1_000) * 1_000;
}

function getBrkConfig() {
  return {
    baseUrl: process.env.BRK_BASE_URL?.trim() || "",
    apiKey: process.env.BRK_API_KEY?.trim() || "",
  };
}

function hasBrkConfig() {
  const { baseUrl, apiKey } = getBrkConfig();
  return Boolean(baseUrl && apiKey);
}

function markSourceFailure(error, context = {}) {
  circuitState.failures += 1;

  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }

  logStructuredEvent("warn", "driver-validation.brk.failure", {
    correlationId: context.correlationId || null,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
    message: error instanceof Error ? error.message : String(error),
  });
}

function markSourceSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePlate(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildUnavailable(errorCode) {
  return {
    availability: "UNAVAILABLE",
    errorCode: errorCode || "BRK_UNAVAILABLE",
  };
}

/**
 * Consulta a aptidao de um conjunto (motorista + cavalo + carreta) no BRK.
 *
 * @param {object} params
 * @param {string} params.cpf - CPF do motorista (qualquer formato; normalizado para 11 digitos)
 * @param {string[]} [params.placas] - placas do conjunto (cavalo, carreta...) — opcional
 * @param {string} [params.correlationId]
 * @returns {Promise<{availability:"OK"|"UNAVAILABLE", errorCode?:string, ...resposta}>}
 *   Em sucesso, espalha a resposta do robo (ok/conjunto_apto/status/color/label/componentes/consultado_em).
 */
export async function consultarBrkPainel({ cpf, placas, correlationId } = {}) {
  const normalizedCpf = normalizeCpf(cpf);

  if (!normalizedCpf) {
    return buildUnavailable("BRK_MISSING_CPF");
  }

  // Config ausente nao e falha transiente — nao aciona o breaker.
  if (!hasBrkConfig()) {
    logStructuredEvent("info", "driver-validation.brk.skipped", {
      correlationId: correlationId || null,
      reason: "BRK_NOT_CONFIGURED",
    });
    return buildUnavailable("BRK_NOT_CONFIGURED");
  }

  if (isCircuitOpen()) {
    logStructuredEvent("info", "driver-validation.brk.skipped", {
      correlationId: correlationId || null,
      reason: "BRK_CIRCUIT_OPEN",
    });
    return buildUnavailable("BRK_CIRCUIT_OPEN");
  }

  const { baseUrl, apiKey } = getBrkConfig();
  const url = new URL("/api/brk/consultar", baseUrl);
  url.searchParams.set("cpf", normalizedCpf);

  (Array.isArray(placas) ? placas : [])
    .map((placa) => normalizePlate(placa))
    .filter(Boolean)
    .forEach((placa) => url.searchParams.append("placa", placa));

  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
      signal: AbortSignal.timeout(getTimeoutMs()),
    });

    if (!response.ok) {
      // Consumir body para liberar a conexao no pool do undici
      await response.text().catch(() => {});
      throw new Error(`BRK_QUERY_FAILED:${response.status}`);
    }

    const payload = await response.json();

    // status:"erro" (ex: "sessao expirada") = servico indisponivel.
    // Tratamos como UNAVAILABLE para NAO sobrescrever o ultimo valor bom.
    if (payload?.status === "erro" || payload?.ok === false) {
      markSourceFailure(new Error(`BRK_SERVICE_ERROR:${payload?.status || "unknown"}`), { correlationId });
      return buildUnavailable("BRK_SERVICE_ERROR");
    }

    markSourceSuccess();

    logStructuredEvent("info", "driver-validation.brk.lookup_completed", {
      correlationId: correlationId || null,
      status: payload?.status || null,
      conjuntoApto: payload?.conjunto_apto ?? null,
      latencyMs: Date.now() - startedAt,
    });

    return {
      availability: "OK",
      ...payload,
    };
  } catch (error) {
    markSourceFailure(error, { correlationId });
    logStructuredEvent("warn", "driver-validation.brk.lookup_failed", {
      correlationId: correlationId || null,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    return buildUnavailable(error instanceof Error ? error.message : String(error));
  }
}

export function resetBrkClientStateForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
