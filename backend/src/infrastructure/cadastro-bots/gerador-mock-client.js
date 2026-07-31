/**
 * Cliente HTTP para o sidecar gerador-mock-angellira (bots/gerador-mock-angellira,
 * porta 8000).
 *
 * O sidecar (FastAPI, 100% local — sem AngelLira) renderiza o "Risk Assessment
 * Document" (dossiê de gerenciamento de risco) no formato AngelLira a partir do
 * JSON do cadastro (`pending_driver_registrations.dados`). Substitui o
 * unificada-bot na geração do PDF do fluxo SPX (a unificada foi pausada).
 *
 * Espelha as convenções de unificada-bot-client / spx-bot-client: circuit
 * breaker, erro estruturado (GeradorMockError) e logging estruturado.
 *
 * Endpoints do sidecar:
 *   GET  /health       -> { ok, service, auth }
 *   POST /api/render    -> ?format=base64 -> { ok, filename, components, warnings, pdf_base64 }
 *                          (default -> application/pdf binário)
 *
 * Auth: se GERADOR_MOCK_API_KEY estiver setado, envia o header X-API-Key
 * (o sidecar só exige quando a env API_KEY dele também estiver setada).
 */

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BOT_URL = "http://gerador-mock-angellira:8000";
// Render é ReportLab local (sem chamadas externas) — rápido. 30s dá folga.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

const circuitState = { failures: 0, openUntil: 0 };

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function getBaseUrl() {
  return (process.env.GERADOR_MOCK_URL?.trim() || DEFAULT_BOT_URL).replace(/\/$/, "");
}
function getTimeoutMs() {
  return parsePositiveIntegerEnv("GERADOR_MOCK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}
function getFailureThreshold() {
  return parsePositiveIntegerEnv("GERADOR_MOCK_CIRCUIT_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}
function getCooldownMs() {
  return parsePositiveIntegerEnv("GERADOR_MOCK_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}
function getApiKey() {
  return process.env.GERADOR_MOCK_API_KEY?.trim() || "";
}

function isCircuitOpen() { return circuitState.openUntil > Date.now(); }
function recordCircuitFailure(context) {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
  logStructuredEvent("warn", "gerador-mock.failure", {
    ...context,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
  });
}
function recordCircuitSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

export class GeradorMockError extends Error {
  constructor({ code, message, httpStatus, acao, raw }) {
    super(message);
    this.name = "GeradorMockError";
    this.code = code;
    this.httpStatus = httpStatus ?? null;
    this.acao = acao ?? null;
    this.raw = raw ?? null;
  }
  toJSON() {
    return {
      code: this.code, message: this.message,
      httpStatus: this.httpStatus, acao: this.acao, raw: this.raw,
    };
  }
}

function mapBotError({ httpStatus, body, fallbackMessage }) {
  const detail = body?.detail;
  const detailObj = (detail && typeof detail === "object") ? detail : null;
  const erroMsg =
    detailObj?.erro
    || body?.erro
    || (typeof detail === "string" ? detail : null)
    // /api/render de erro (422) devolve { ok:false, warnings:[...] }
    || (Array.isArray(body?.warnings) && body.warnings.length ? body.warnings.join("; ") : null);

  if (httpStatus === 400) {
    return new GeradorMockError({
      code: "GERADOR_MOCK_BAD_REQUEST",
      message: erroMsg || "Body inválido (esperado o JSON do cadastro).",
      acao: "Verifique os dados do cadastro.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 401) {
    return new GeradorMockError({
      code: "GERADOR_MOCK_UNAUTHORIZED",
      message: erroMsg || "API key inválida ou ausente (X-API-Key).",
      acao: "Confira GERADOR_MOCK_API_KEY no backend.env e a API_KEY do sidecar.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 422) {
    return new GeradorMockError({
      code: "GERADOR_MOCK_SEM_COMPONENTE",
      message: erroMsg || "Nenhum componente reconhecido (motorista/cavalo/carreta) ou bloqueado pelo enforce.",
      acao: "Confira se o cadastro tem motorista/veículo com os dados mínimos.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 503) {
    return new GeradorMockError({
      code: "GERADOR_MOCK_INDISPONIVEL",
      message: "Sidecar gerador-mock-angellira indisponível.",
      acao: "Verifique o container gerador-mock-angellira.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus >= 500 || httpStatus === 0) {
    return new GeradorMockError({
      code: "GERADOR_MOCK_UNAVAILABLE",
      message: fallbackMessage || "Sidecar gerador-mock não respondeu.",
      acao: "Aguarde alguns segundos e tente novamente.",
      httpStatus, raw: body,
    });
  }
  return new GeradorMockError({
    code: "GERADOR_MOCK_UNKNOWN_ERROR",
    message: fallbackMessage || `HTTP ${httpStatus} inesperado do sidecar gerador-mock.`,
    acao: "Contate o suporte com este código.",
    httpStatus, raw: body,
  });
}

async function request({ method, path, body, correlationId }) {
  if (isCircuitOpen()) {
    throw new GeradorMockError({
      code: "GERADOR_MOCK_CIRCUIT_OPEN",
      message: "Sidecar gerador-mock temporariamente bloqueado (muitas falhas seguidas).",
      acao: "Aguarde ~1 minuto e tente novamente.",
      httpStatus: 0,
    });
  }

  const url = `${getBaseUrl()}${path}`;
  const timeoutMs = getTimeoutMs();
  const headers = { "Content-Type": "application/json" };
  if (correlationId) headers["X-Correlation-Id"] = correlationId;
  const apiKey = getApiKey();
  if (apiKey) headers["X-API-Key"] = apiKey;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(t);

    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { detail: text.slice(0, 500) }; }
    }

    logStructuredEvent("info", "gerador-mock.request", {
      path, method, httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      correlationId: correlationId ?? null,
      ok: response.ok,
    });

    if (response.status === 0 || response.status >= 500) {
      recordCircuitFailure({ path, method, httpStatus: response.status, correlationId });
    } else {
      recordCircuitSuccess();
    }
    return { httpStatus: response.status, body: parsed };
  } catch (err) {
    clearTimeout(t);
    const isTimeout = err?.name === "AbortError";
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStructuredEvent("warn", "gerador-mock.request_failed", {
      path, method,
      durationMs: Date.now() - startedAt,
      correlationId: correlationId ?? null,
      timeout: isTimeout,
      message: errorMsg,
    });
    recordCircuitFailure({ path, method, httpStatus: 0, correlationId });
    return { httpStatus: 0, body: { detail: isTimeout ? "timeout" : errorMsg } };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// API pública
// ──────────────────────────────────────────────────────────────────────────

export async function health() {
  const url = `${getBaseUrl()}/health`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const body = await response.json().catch(() => null);
    return { ok: response.ok, httpStatus: response.status, body };
  } catch (err) {
    clearTimeout(t);
    return { ok: false, httpStatus: 0, body: { detail: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Garante que a CNH esteja em `motorista.cnh` (o mapeador do sidecar lê
 * `motorista.cnh`). Alguns cadastros gravam a CNH no topo (`dados.cnh`).
 * Cópia rasa não-destrutiva — não muta o `dados` original.
 */
function normalizeDados(dados) {
  const d = { ...(dados && typeof dados === "object" ? dados : {}) };
  const motorista = { ...(d.motorista && typeof d.motorista === "object" ? d.motorista : {}) };
  if (!motorista.cnh && d.cnh) motorista.cnh = d.cnh;
  d.motorista = motorista;
  return d;
}

/**
 * Gera o dossiê (Risk Assessment Document) no formato AngelLira em PDF, a partir
 * do `dados` do cadastro. O sidecar mapeia motorista/cavalo/carreta e renderiza.
 *
 * @param {object} args
 * @param {object} args.dados        pending_driver_registrations.dados
 * @param {boolean} [args.enforce]   gate abort-all "Conforme" (default false)
 * @param {string} [args.correlationId]
 * @returns {Promise<{ok:true, pdf:Buffer, filename:string|null, components:object|null, warnings:Array|null}>}
 */
export async function gerarPdfMock({ dados, enforce = false, correlationId } = {}) {
  const normalized = normalizeDados(dados);
  const hasMotorista = normalized.motorista && Object.keys(normalized.motorista).some((k) => k !== "cnh" && normalized.motorista[k]);
  const hasVeiculo = normalized.cavalo || (Array.isArray(normalized.carretas) && normalized.carretas.length) || normalized.carreta;
  if (!hasMotorista && !hasVeiculo) {
    throw new GeradorMockError({
      code: "GERADOR_MOCK_BAD_REQUEST",
      message: "Cadastro sem motorista nem veículo — nada para renderizar.",
      acao: "Verifique os dados do cadastro.",
      httpStatus: 400,
    });
  }

  const { httpStatus, body } = await request({
    method: "POST",
    path: `/api/render?format=base64${enforce ? "&enforce=true" : ""}`,
    body: normalized,
    correlationId,
  });

  if (httpStatus === 200 && body?.ok === true && body?.pdf_base64) {
    const pdf = Buffer.from(body.pdf_base64, "base64");
    if (pdf.length === 0) {
      throw mapBotError({ httpStatus: 502, body, fallbackMessage: "PDF vazio retornado pelo gerador-mock." });
    }
    return {
      ok: true,
      pdf,
      filename: body.filename ?? null,
      components: body.components ?? null,
      warnings: body.warnings ?? null,
    };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao gerar o dossiê (gerador-mock)." });
}

export function __resetCircuitForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
