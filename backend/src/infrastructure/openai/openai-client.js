// backend/src/infrastructure/openai/openai-client.js
//
// Cliente OpenAI (Chat Completions) para o "agente orientador" do cadastro
// Repom. Estrutura espelha `infrastructure/whatsapp/evolution-client.js`:
// env-driven, `fetch` com timeout, circuit breaker (3 falhas → cooldown 60s).
// SEM dependência nova — usa o `fetch` global (undici).
//
// Privacidade: os logs estruturados NUNCA carregam o conteúdo das mensagens
// (nem do motorista, nem do modelo) — só correlation-id, modelo e uso de tokens.
//
// Segurança: este cliente é BURRO de propósito — só faz uma chamada de texto e
// devolve o texto. Quem escreve o system prompt e trata o resultado é a camada
// application (agent-orientador.js). O agente nunca executa ações.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 220;
const DEFAULT_TEMPERATURE = 0.3;

// Estado do circuito (process-local); igual ao evolution-client.
const circuitState = { failures: 0, openUntil: 0 };

// ─── Erros tipados ────────────────────────────────────────────────────────────

export class OpenAiCircuitOpenError extends Error {
  constructor(message = "OPENAI_CIRCUIT_OPEN") {
    super(message);
    this.name = "OpenAiCircuitOpenError";
    this.code = "OPENAI_CIRCUIT_OPEN";
  }
}

export class OpenAiMissingConfigError extends Error {
  constructor(envName = "OPENAI_API_KEY") {
    super(`Missing required environment variable: ${envName}`);
    this.name = "OpenAiMissingConfigError";
    this.code = "OPENAI_MISSING_CONFIG";
    this.envName = envName;
  }
}

// ─── Helpers de env ───────────────────────────────────────────────────────────

function parsePositiveIntegerEnv(name, fallbackValue) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackValue;
}

export function getOpenAiBaseUrl() {
  return process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

export function getOpenAiModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function getOpenAiKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new OpenAiMissingConfigError("OPENAI_API_KEY");
  return key;
}

/** true se há chave configurada (permite o caller decidir sem try/catch). */
export function isOpenAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("OPENAI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export function isCircuitOpen() {
  if (circuitState.openUntil > 0 && circuitState.openUntil <= Date.now()) {
    circuitState.failures = 0;
    circuitState.openUntil = 0;
    return false;
  }
  return circuitState.openUntil > Date.now();
}

function markSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

function markFailure() {
  circuitState.failures += 1;
  if (circuitState.failures >= DEFAULT_FAILURE_THRESHOLD) {
    circuitState.openUntil = Date.now() + DEFAULT_COOLDOWN_MS;
  }
}

// ─── Fetch com timeout ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || getTimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── API pública: uma rodada de chat (system + user) → texto ───────────────────

/**
 * Faz UMA chamada de chat (sem histórico, sem tools) e devolve o texto.
 *
 * @param {object} args
 * @param {string} args.system - instrução de sistema (escopo/guardrails do agente)
 * @param {string} args.user   - conteúdo do usuário (texto do motorista; NÃO confiável)
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature]
 * @param {string} [args.correlationId]
 *
 * @returns {Promise<{text: string, usage: object|null, model: string}>}
 * @throws {OpenAiCircuitOpenError} circuito aberto
 * @throws {OpenAiMissingConfigError} OPENAI_API_KEY ausente
 * @throws {Error} falha de transporte / resposta não-2xx / corpo inesperado
 */
export async function chatComplete({ system, user, maxTokens, temperature, correlationId } = {}) {
  if (isCircuitOpen()) throw new OpenAiCircuitOpenError();

  const key = getOpenAiKey();
  const model = getOpenAiModel();
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(`${getOpenAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        // Papéis separados: o texto do motorista fica ISOLADO no role `user` —
        // nunca no `system`. É a base da defesa a prompt-injection.
        messages: [
          { role: "system", content: String(system || "") },
          { role: "user", content: String(user || "") },
        ],
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
        temperature: Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`OPENAI_HTTP_${response.status}${errorBody ? `:${errorBody.slice(0, 120)}` : ""}`);
    }

    const data = await response.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) {
      throw new Error("OPENAI_EMPTY_RESPONSE");
    }

    markSuccess();
    logStructuredEvent("info", "openai.chat.success", {
      context: "repom-agent",
      correlationId: correlationId || null,
      model,
      // uso de tokens é métrica, não conteúdo — seguro logar.
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
      durationMs: Date.now() - startedAt,
    });

    return { text: String(text).trim(), usage: data?.usage || null, model };
  } catch (error) {
    markFailure();
    logStructuredEvent("warn", "openai.chat.failure", {
      context: "repom-agent",
      correlationId: correlationId || null,
      model,
      error: error instanceof Error ? error.message : String(error),
      failures: circuitState.failures,
      circuitOpenUntil: circuitState.openUntil || null,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

// ─── Utilitários para tests ─────────────────────────────────────────────────────

export function resetOpenAiClientStateForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
