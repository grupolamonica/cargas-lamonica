// backend/src/infrastructure/torre/torre-client.js
//
// Cliente HTTP para a API de integração da Torre de Controle
// (GET /api/integrations/drivers/:cpf) — dossiê completo do motorista por CPF,
// incluindo o bloco `ranking` (posicao/pontuacao/vinculo/status) exibido na
// revisão de cadastro do operador.
//
// Autenticação server-to-server por header `x-api-key` (env TORRE_API_KEY —
// mesma INTEGRATION_API_KEY do torre-backend). A Torre já cacheia a resposta
// por 60s no Redis; aqui mantemos cache local com o mesmo TTL + circuit
// breaker no padrão do angellira-client.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BASE_URL = "https://torre.grupolamonica.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 60;

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallbackValue;
  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getBaseUrl() {
  const raw = process.env.TORRE_API_BASE_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("TORRE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function getCacheTtlMs() {
  return parsePositiveIntegerEnv("TORRE_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS) * 1000;
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("TORRE_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("TORRE_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS) * 1000;
}

function maskCpf(digits) {
  const value = String(digits || "");
  if (value.length === 0) return "***";
  return `${value.slice(0, 3)}***`;
}

function normalizeCpfDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

const resultCache = new Map();
const circuitState = { failures: 0, openUntil: 0 };

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function markSourceFailure() {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
}

function markSourceSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || getTimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Consulta o dossiê do motorista na Torre por CPF.
 *
 * @param {string} cpf CPF (qualquer formato — normalizado para 11 dígitos).
 * @param {object} [options]
 * @param {string} [options.correlationId]
 *
 * @returns {Promise<{ found: boolean, data: object | null }>}
 *   found=false quando a Torre não tem nenhum vestígio do CPF (HTTP 404).
 *
 * @throws Error("TORRE_INVALID_INPUT")       CPF sem 11 dígitos
 * @throws Error("TORRE_NOT_CONFIGURED")      TORRE_API_KEY ausente
 * @throws Error("TORRE_UNAUTHORIZED")        chave rejeitada pela Torre (401/403)
 * @throws Error("TORRE_SOURCE_TIMEOUT")      timeout/erro de rede
 * @throws Error("TORRE_SOURCE_UNAVAILABLE")  5xx ou circuit breaker aberto
 * @throws Error("TORRE_API_ERROR:<status>")  status inesperado
 */
export async function lookupTorreDriverByCpf(cpf, { correlationId } = {}) {
  const cpfDigits = normalizeCpfDigits(cpf);
  if (cpfDigits.length !== 11) {
    throw new Error("TORRE_INVALID_INPUT");
  }

  const apiKey = process.env.TORRE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TORRE_NOT_CONFIGURED");
  }

  const cached = resultCache.get(cpfDigits);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  if (isCircuitOpen()) {
    logStructuredEvent("warn", "torre.lookup_driver.circuit_open", {
      correlationId: correlationId || null,
      cpfMasked: maskCpf(cpfDigits),
    });
    throw new Error("TORRE_SOURCE_UNAVAILABLE");
  }

  let response;
  try {
    response = await fetchWithTimeout(`${getBaseUrl()}/api/integrations/drivers/${cpfDigits}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });
  } catch (networkError) {
    markSourceFailure();
    logStructuredEvent("warn", "torre.lookup_driver.network_error", {
      correlationId: correlationId || null,
      cpfMasked: maskCpf(cpfDigits),
      message: networkError instanceof Error ? networkError.message : String(networkError),
    });
    throw new Error("TORRE_SOURCE_TIMEOUT", { cause: networkError });
  }

  if (response.status === 404) {
    markSourceSuccess();
    const result = { found: false, data: null };
    resultCache.set(cpfDigits, { result, expiresAt: Date.now() + getCacheTtlMs() });
    return result;
  }

  if (response.status === 401 || response.status === 403) {
    // Chave inválida não é falha transitória — não conta para o circuit breaker.
    logStructuredEvent("error", "torre.lookup_driver.unauthorized", {
      correlationId: correlationId || null,
      httpStatus: response.status,
    });
    throw new Error("TORRE_UNAUTHORIZED");
  }

  if (response.status === 400) {
    throw new Error("TORRE_INVALID_INPUT");
  }

  if (response.status >= 500) {
    markSourceFailure();
    logStructuredEvent("warn", "torre.lookup_driver.upstream_error", {
      correlationId: correlationId || null,
      httpStatus: response.status,
    });
    throw new Error("TORRE_SOURCE_UNAVAILABLE");
  }

  if (response.status !== 200) {
    throw new Error(`TORRE_API_ERROR:${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    markSourceFailure();
    throw new Error("TORRE_API_ERROR:invalid_json");
  }

  markSourceSuccess();
  const result = { found: true, data: payload };
  resultCache.set(cpfDigits, { result, expiresAt: Date.now() + getCacheTtlMs() });
  return result;
}

export function resetTorreClientStateForTests() {
  resultCache.clear();
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
