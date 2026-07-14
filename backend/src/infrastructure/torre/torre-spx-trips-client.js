// backend/src/infrastructure/torre/torre-spx-trips-client.js
//
// Cliente HTTP (READ-ONLY) para a API de viagens SPX da Torre de Controle
// (DC-136): GET https://torre.grupolamonica.com/api/spx/asp — devolve as viagens
// line-haul do portal SPX/Shopee ao vivo, juntando os 3 tabs do SPX
// (Planejado / Aceito / Concluído). É a fonte da tela "Programação" do operador.
//
// Autenticação server-to-server por header `x-api-key`. A chave é o secret
// dedicado SPX_ASP_API_KEY do sistema Torre (DC-136) — lido aqui de
// TORRE_SPX_ASP_API_KEY, com fallback para TORRE_API_KEY (a INTEGRATION_API_KEY do
// torre-backend) quando a dedicada não está setada. Sem nenhuma das duas →
// SpxAspNotConfigured (o read model devolve 503, sem quebrar o boot).
//
// A leitura passa OBRIGATORIAMENTE pelo nosso backend porque a Torre bloqueia CORS
// de browser em outro domínio (ver DC-136 §7). Cache local (TTL 60s, por querystring)
// + circuit breaker no mesmo padrão de torre-client.js — a Torre já cacheia 60s.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BASE_URL = "https://torre.grupolamonica.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 60;

export class SpxAspNotConfigured extends Error {
  constructor(message = "API de viagens SPX (DC-136) não configurada (TORRE_SPX_ASP_API_KEY/TORRE_API_KEY ausente).") {
    super(message);
    this.name = "SpxAspNotConfigured";
  }
}

export class SpxAspUnauthorized extends Error {
  constructor(message = "Chave da API de viagens SPX (DC-136) inválida ou expirada.") {
    super(message);
    this.name = "SpxAspUnauthorized";
  }
}

export class SpxAspUnavailable extends Error {
  constructor(message = "API de viagens SPX (DC-136) temporariamente indisponível.") {
    super(message);
    this.name = "SpxAspUnavailable";
  }
}

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
  return parsePositiveIntegerEnv("TORRE_SPX_ASP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}
function getCacheTtlMs() {
  return parsePositiveIntegerEnv("TORRE_SPX_ASP_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS) * 1000;
}
function getFailureThreshold() {
  return parsePositiveIntegerEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}
function getCooldownMs() {
  return parsePositiveIntegerEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS) * 1000;
}

/** Chave dedicada (DC-136) com fallback para a chave geral da Torre. */
function getApiKey() {
  return (process.env.TORRE_SPX_ASP_API_KEY?.trim() || process.env.TORRE_API_KEY?.trim() || "");
}

/** A tela pode se auto-desabilitar quando a integração não está configurada. */
export function isSpxAspConfigured() {
  return getApiKey().length > 0;
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

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Puxa as viagens SPX da API DC-136.
 *
 * @param {{ daysBack?: number, daysFwd?: number, queryType?: 1|2|3 }} [params]
 *   queryType: 1=Planejado, 2=Aceito, 3=Concluído. Omitido = os 3 tabs juntos.
 * @param {{ correlationId?: string, fetchImpl?: typeof fetch }} [options]
 *
 * @returns {Promise<{ ok: boolean, columns: string[], total: number,
 *   byTab: Record<string, number>, errors: unknown[], rows: Array<Record<string, unknown>> }>}
 *
 * @throws {SpxAspNotConfigured}  nenhuma chave configurada
 * @throws {SpxAspUnauthorized}   401/403 (chave rejeitada pela Torre)
 * @throws {SpxAspUnavailable}    timeout/rede/5xx/circuit aberto/JSON inválido
 */
export async function fetchSpxTrips(
  { daysBack, daysFwd, queryType } = {},
  { correlationId, fetchImpl = globalThis.fetch } = {},
) {
  const apiKey = getApiKey();
  if (!apiKey) throw new SpxAspNotConfigured();

  const params = new URLSearchParams();
  if (Number.isFinite(daysBack)) params.set("days_back", String(daysBack));
  if (Number.isFinite(daysFwd)) params.set("days_fwd", String(daysFwd));
  if (queryType != null) params.set("query_type", String(queryType));
  const qs = params.toString();

  const cacheKey = qs || "__all__";
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (isCircuitOpen()) {
    logStructuredEvent("warn", "spx_asp.circuit_open", { correlationId: correlationId || null, queryType: queryType ?? null });
    throw new SpxAspUnavailable("Circuito aberto após falhas repetidas na API SPX.");
  }

  const url = `${getBaseUrl()}/api/spx/asp${qs ? `?${qs}` : ""}`;
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: "GET",
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });
  } catch (networkError) {
    markSourceFailure();
    logStructuredEvent("warn", "spx_asp.network_error", {
      correlationId: correlationId || null,
      queryType: queryType ?? null,
      message: networkError instanceof Error ? networkError.message : String(networkError),
    });
    throw new SpxAspUnavailable("Falha de rede ao consultar a API SPX.");
  }

  if (response.status === 401 || response.status === 403) {
    // Chave inválida não é falha transitória — não conta pro circuit breaker.
    logStructuredEvent("error", "spx_asp.unauthorized", { correlationId: correlationId || null, httpStatus: response.status });
    throw new SpxAspUnauthorized();
  }

  if (response.status >= 500) {
    markSourceFailure();
    logStructuredEvent("warn", "spx_asp.upstream_error", { correlationId: correlationId || null, httpStatus: response.status });
    throw new SpxAspUnavailable(`API SPX respondeu HTTP ${response.status}.`);
  }

  if (response.status !== 200) {
    throw new SpxAspUnavailable(`API SPX respondeu HTTP inesperado ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    markSourceFailure();
    throw new SpxAspUnavailable("Resposta da API SPX não é JSON válido.");
  }

  markSourceSuccess();
  resultCache.set(cacheKey, { value: payload, expiresAt: Date.now() + getCacheTtlMs() });
  return payload;
}

export function resetSpxAspClientStateForTests() {
  resultCache.clear();
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
