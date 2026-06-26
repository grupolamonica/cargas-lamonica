/**
 * Cliente HTTP para o sidecar unificada-bot (bots/unificada, porta 8001).
 *
 * O sidecar (FastAPI, API-only — sem Selenium) gera o "Risk Assessment Document"
 * (dossiê de gerenciamento de risco) a partir da API pública do AngelLira,
 * unificando Motorista + Cavalo + Carreta num único PDF. Também expõe consulta
 * de status/vigência (Conforme + limitDate) por CPF/placa.
 *
 * Espelha as convenções de spx-bot-client / angellira-bot-client: circuit
 * breaker, erro estruturado (UnificadaBotError) e logging estruturado.
 *
 * Endpoints do sidecar:
 *   GET  /health                  -> { ok, service }
 *   POST /relatorio/status        -> { ok, status, status_description, item, erro }
 *   POST /relatorio/consultar     -> { ok, encontrado, total, registro }
 *   POST /relatorio/pdf_unificado -> application/pdf (binário) + headers X-Components/X-Warnings
 *
 * Epic SPX (extensão Lamônica) — Fase 1 (unificada/dossiê).
 */

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BOT_URL = "http://unificada-bot:8001";
// Gerar o PDF consulta a API AngelLira por CPF + cada placa (~3s/chamada, serial)
// e renderiza com ReportLab. 120s dá folga sem incentivar enxurrada de retries.
const DEFAULT_TIMEOUT_MS = 120_000;
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
  return (process.env.UNIFICADA_BOT_URL?.trim() || DEFAULT_BOT_URL).replace(/\/$/, "");
}
function getTimeoutMs() {
  return parsePositiveIntegerEnv("UNIFICADA_BOT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}
function getFailureThreshold() {
  return parsePositiveIntegerEnv("UNIFICADA_BOT_CIRCUIT_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}
function getCooldownMs() {
  return parsePositiveIntegerEnv("UNIFICADA_BOT_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

function isCircuitOpen() { return circuitState.openUntil > Date.now(); }
function recordCircuitFailure(context) {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
  logStructuredEvent("warn", "unificada-bot.failure", {
    ...context,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
  });
}
function recordCircuitSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

export class UnificadaBotError extends Error {
  constructor({ code, message, httpStatus, acao, raw }) {
    super(message);
    this.name = "UnificadaBotError";
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
  const erroMsg = detailObj?.erro || body?.erro || (typeof detail === "string" ? detail : null);

  if (httpStatus === 400) {
    return new UnificadaBotError({
      code: "UNIFICADA_BAD_REQUEST",
      message: erroMsg || "Dados insuficientes (informe CPF e/ou placas).",
      acao: "Verifique CPF e placas do cadastro.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 502) {
    return new UnificadaBotError({
      code: "UNIFICADA_DOWNSTREAM_FAIL",
      message: erroMsg || "Falha ao gerar o dossiê (API AngelLira / ReportLab).",
      acao: "Tente novamente. Se persistir, confira as credenciais ANGELIRA_API_* e a API AngelLira.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 503) {
    return new UnificadaBotError({
      code: "UNIFICADA_BOT_INDISPONIVEL",
      message: "Sidecar unificada indisponível.",
      acao: "Verifique o container unificada-bot.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus >= 500 || httpStatus === 0) {
    return new UnificadaBotError({
      code: "UNIFICADA_BOT_UNAVAILABLE",
      message: fallbackMessage || "Sidecar unificada não respondeu.",
      acao: "Aguarde alguns segundos e tente novamente.",
      httpStatus, raw: body,
    });
  }
  return new UnificadaBotError({
    code: "UNIFICADA_UNKNOWN_ERROR",
    message: fallbackMessage || `HTTP ${httpStatus} inesperado do sidecar unificada.`,
    acao: "Contate o suporte com este código.",
    httpStatus, raw: body,
  });
}

async function request({ method, path, body, correlationId, parse = "json" }) {
  if (isCircuitOpen()) {
    throw new UnificadaBotError({
      code: "UNIFICADA_BOT_CIRCUIT_OPEN",
      message: "Sidecar unificada temporariamente bloqueado (muitas falhas seguidas).",
      acao: "Aguarde ~1 minuto e tente novamente.",
      httpStatus: 0,
    });
  }

  const url = `${getBaseUrl()}${path}`;
  const timeoutMs = getTimeoutMs();
  const headers = { "Content-Type": "application/json" };
  if (correlationId) headers["X-Correlation-Id"] = correlationId;

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

    let parsed = null;
    let pdf = null;
    if (parse === "binary" && response.ok) {
      pdf = Buffer.from(await response.arrayBuffer());
    } else {
      const text = await response.text();
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { detail: text.slice(0, 500) }; }
      }
    }

    logStructuredEvent("info", "unificada-bot.request", {
      path, method, httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      correlationId: correlationId ?? null,
      ok: response.ok,
      bytes: pdf ? pdf.length : null,
    });

    if (response.status === 0 || response.status >= 500) {
      recordCircuitFailure({ path, method, httpStatus: response.status, correlationId });
    } else {
      recordCircuitSuccess();
    }
    return { httpStatus: response.status, headers: response.headers, body: parsed, pdf };
  } catch (err) {
    clearTimeout(t);
    const isTimeout = err?.name === "AbortError";
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStructuredEvent("warn", "unificada-bot.request_failed", {
      path, method,
      durationMs: Date.now() - startedAt,
      correlationId: correlationId ?? null,
      timeout: isTimeout,
      message: errorMsg,
    });
    recordCircuitFailure({ path, method, httpStatus: 0, correlationId });
    return { httpStatus: 0, headers: null, body: { detail: isTimeout ? "timeout" : errorMsg }, pdf: null };
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
 * Consulta status/vigência de um CPF ou placa no AngelLira (read-only).
 * @param {object} args
 * @param {string} args.queryValue  CPF (11 dígitos) ou placa.
 * @param {"cpf"|"plate"} args.qFor
 * @returns {Promise<{ok, status, status_description, item, erro, raw}>}
 */
export async function consultarStatus({ queryValue, qFor, correlationId }) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/relatorio/status",
    body: { query_value: queryValue, q_for: qFor },
    correlationId,
  });
  if (httpStatus === 200 && body?.ok != null) {
    return { ...body, raw: body };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao consultar status no AngelLira." });
}

/**
 * Gera o dossiê (Risk Assessment Document) unificado em PDF.
 * Pelo menos um de {cpf, placaCavalo, placaCarreta} deve ser informado.
 *
 * @param {object} args
 * @param {string} [args.cpf]
 * @param {string} [args.placaCavalo]
 * @param {string} [args.placaCarreta]
 * @returns {Promise<{ok:true, pdf:Buffer, contentType:string, components:string|null, warnings:string|null}>}
 */
export async function gerarPdfUnificado({ cpf, placaCavalo, placaCarreta, correlationId }) {
  if (!cpf && !placaCavalo && !placaCarreta) {
    throw new UnificadaBotError({
      code: "UNIFICADA_BAD_REQUEST",
      message: "Informe pelo menos um de: cpf, placaCavalo, placaCarreta.",
      acao: "Verifique os dados do cadastro.",
      httpStatus: 400,
    });
  }
  const { httpStatus, headers, body, pdf } = await request({
    method: "POST",
    path: "/relatorio/pdf_unificado",
    body: { cpf: cpf || null, placa_cavalo: placaCavalo || null, placa_carreta: placaCarreta || null },
    correlationId,
    parse: "binary",
  });
  if (httpStatus === 200 && pdf && pdf.length > 0) {
    return {
      ok: true,
      pdf,
      contentType: headers?.get?.("content-type") || "application/pdf",
      // Headers vêm como repr Python (str(dict)/str(list)) — guardamos crus p/ diagnóstico.
      components: headers?.get?.("x-components") || null,
      warnings: headers?.get?.("x-warnings") || null,
    };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao gerar o dossiê unificado." });
}

export function __resetCircuitForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
