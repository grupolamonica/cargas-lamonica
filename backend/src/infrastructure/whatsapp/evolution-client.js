// backend/src/infrastructure/whatsapp/evolution-client.js
//
// Cliente Evolution API com circuit breaker (CADASTRO-12 / Phase 07 Plan 06).
// Estrutura espelha `infrastructure/angellira/angellira-client.js`: env-driven,
// circuito abre apos 3 falhas, cooldown 60s. Usado APENAS pelo worker assincrono
// (notification-worker) — nao expoe APIs HTTP publicas.
//
// Privacidade (T-07-28): logs estruturados NUNCA carregam o texto da mensagem
// nem o telefone completo — apenas templateKey + correlation-id + sufixo do
// telefone (ultimos 2 digitos).

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";
// Nota: cliente de TEXTO LIVRE (driver-outreach compõe a mensagem na camada
// application). Sem catálogo de templates — evita acoplar a templates de outros
// fluxos (cadastro/claim).

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_EVOLUTION_URL = "http://evolution-api:8080";
const DEFAULT_EVOLUTION_INSTANCE = "lamonica";
// Instância dedicada ao cadastro de motorista (Repom) — número separado do de
// Cargas. Multi-instância do Evolution (mesmo servidor, nomes diferentes).
const DEFAULT_REPOM_INSTANCE = "lamonica-repom";

// Estado interno do circuito (process-local). Reset em sucesso; abre apos
// `DEFAULT_FAILURE_THRESHOLD` falhas consecutivas; cooldown `DEFAULT_COOLDOWN_MS`.
const circuitState = {
  failures: 0,
  openUntil: 0,
};

// Importacao tardia (cyclic-safe) — templates.js nao depende deste modulo.

// ─── Erros tipados ────────────────────────────────────────────────────────────

export class EvolutionCircuitOpenError extends Error {
  constructor(message = "EVOLUTION_CIRCUIT_OPEN") {
    super(message);
    this.name = "EvolutionCircuitOpenError";
    this.code = "EVOLUTION_CIRCUIT_OPEN";
  }
}

export class MissingConfigError extends Error {
  constructor(envName) {
    super(`Missing required environment variable: ${envName}`);
    this.name = "MissingConfigError";
    this.code = "MISSING_CONFIG";
    this.envName = envName;
  }
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.code = "VALIDATION_ERROR";
  }
}

/**
 * Recipiente bloqueado pela allowlist de teste. Lançado quando
 * DRIVER_OUTREACH_TEST_ALLOWLIST está setado e o número não está na lista.
 * NÃO é falha de transporte — o worker trata como "skipped" (sem retry).
 */
export class RecipientNotAllowedError extends Error {
  constructor(maskedPhone) {
    super(`Recipient not in test allowlist: ${maskedPhone}`);
    this.name = "RecipientNotAllowedError";
    this.code = "RECIPIENT_NOT_ALLOWED";
  }
}

/**
 * Allowlist de TESTE (env DRIVER_OUTREACH_TEST_ALLOWLIST — números separados por
 * vírgula). Quando setada, SÓ esses números recebem mensagem; qualquer outro é
 * bloqueado. Vazia/ausente = comportamento normal (produção). É a trava que
 * garante que testes em staging nunca alcancem um motorista real.
 */
function getTestAllowlist() {
  const raw = (process.env.DRIVER_OUTREACH_TEST_ALLOWLIST || "").trim();
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.replace(/\D/g, ""))
      .filter(Boolean),
  );
  return set.size ? set : null;
}

/** true se o número (normalizado) pode receber, dada a allowlist de teste. */
function isRecipientAllowed(normalizedPhone) {
  const allow = getTestAllowlist();
  if (!allow) return true; // sem allowlist → tudo liberado (prod)
  // Compara tolerando presença/ausência de DDI 55.
  const d = String(normalizedPhone || "").replace(/\D/g, "");
  const noDdi = d.startsWith("55") ? d.slice(2) : d;
  return allow.has(d) || allow.has(noDdi) || allow.has(`55${noDdi}`);
}

// ─── Helpers de env ───────────────────────────────────────────────────────────

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

export function getEvolutionUrl() {
  return process.env.EVOLUTION_API_URL?.trim() || DEFAULT_EVOLUTION_URL;
}

export function getEvolutionToken() {
  const token = process.env.EVOLUTION_API_TOKEN?.trim();
  if (!token) {
    throw new MissingConfigError("EVOLUTION_API_TOKEN");
  }
  return token;
}

export function getEvolutionInstance() {
  return process.env.EVOLUTION_API_INSTANCE?.trim() || DEFAULT_EVOLUTION_INSTANCE;
}

/** Instância dedicada ao cadastro Repom (número separado do de Cargas). */
export function getRepomInstance() {
  return process.env.EVOLUTION_REPOM_INSTANCE?.trim() || DEFAULT_REPOM_INSTANCE;
}

/**
 * Resolve a instância-alvo de uma operação: a informada (ex.: a do Repom) ou,
 * por PADRÃO, a de Cargas. Assim toda chamada existente (que não passa instância)
 * segue idêntica — a base do multi-instância retrocompatível.
 */
export function resolveInstance(instance) {
  const trimmed = typeof instance === "string" ? instance.trim() : "";
  return trimmed || getEvolutionInstance();
}

export function getTimeoutMs() {
  return parsePositiveIntegerEnv("EVOLUTION_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export function isCircuitOpen() {
  if (circuitState.openUntil > 0 && circuitState.openUntil <= Date.now()) {
    // Cooldown expirou — reset oportunista (half-open: a proxima chamada
    // tenta o envio; se falhar de novo, abre o circuito novamente).
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

// ─── Normalizacao + mascaramento ──────────────────────────────────────────────

/**
 * Normaliza o numero para o formato esperado pela Evolution API:
 *   - apenas digitos
 *   - se o numero tiver 10 ou 11 digitos (formato brasileiro local), prefixa "55"
 *   - se ja comecar com 55 + 10/11 digitos, mantem
 *   - caso contrario, retorna como veio (apenas digitos)
 */
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) {
    return "";
  }
  // ja prefixado com codigo do pais Brasil (55 + DDD + numero)
  if (/^55\d{10,11}$/.test(digits)) {
    return digits;
  }
  // 10 (fixo) ou 11 digitos (celular) sem DDI → adiciona 55
  if (/^\d{10,11}$/.test(digits)) {
    return `55${digits}`;
  }
  // Outros formatos (numero internacional ou ja com DDI nao-BR): mantem digitos
  return digits;
}

/**
 * Mascaramento PII (T-07-28): preserva apenas os 2 ultimos digitos do telefone
 * para correlacao em logs (ex: "**45"). Telefones < 2 digitos viram "**".
 */
function maskPhoneForLog(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 2) {
    return "**";
  }
  return `**${digits.slice(-2)}`;
}

// ─── Fetch com timeout (undici/global fetch) ──────────────────────────────────

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || getTimeoutMs();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── API publica: envio de texto ──────────────────────────────────────────────

/**
 * Envia uma mensagem de TEXTO via Evolution API (a mensagem já vem composta
 * pela camada application — driver-outreach).
 *
 * @param {object} args
 * @param {string} args.to - numero do destinatario (pode incluir formatacao; normalizado)
 * @param {string} args.text - texto já composto da mensagem
 * @param {string} [args.correlationId] - correlation id para audit/observabilidade
 *
 * @throws {EvolutionCircuitOpenError} circuito aberto
 * @throws {ValidationError} `to` inválido ou texto vazio
 * @throws {MissingConfigError} EVOLUTION_API_TOKEN nao configurado
 * @throws {Error} falha de transporte (rede / 4xx/5xx Evolution)
 */
export async function sendWhatsappText({ to, text, correlationId, delayMs, instance } = {}) {
  if (isCircuitOpen()) {
    throw new EvolutionCircuitOpenError();
  }

  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    throw new ValidationError("Invalid recipient phone");
  }

  if (!text || !String(text).trim()) {
    throw new ValidationError("Empty message text");
  }

  const maskedPhone = maskPhoneForLog(normalizedTo);

  // Trava de teste: se a allowlist está ativa, só ela recebe. Bloqueia ANTES
  // de qualquer chamada de rede — garante que testes em staging jamais alcancem
  // um motorista real.
  if (!isRecipientAllowed(normalizedTo)) {
    logStructuredEvent("warn", "whatsapp.delivery.blocked_allowlist", {
      context: "driver-outreach",
      correlationId: correlationId || null,
      maskedPhone,
    });
    throw new RecipientNotAllowedError(maskedPhone);
  }

  // Acessa token apos checks de input (preserva ordem de erros consistente).
  const token = getEvolutionToken();
  const inst = resolveInstance(instance);
  const url = `${getEvolutionUrl()}/message/sendText/${inst}`;

  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        apikey: token,
      },
      body: JSON.stringify({
        number: normalizedTo,
        text,
        // "digitando…" simulado pelo Evolution: espera `delay` ms com presença
        // de composição antes de mandar. Deixa o envio com cara de humano.
        // Clampado a 15s para não segurar a conexão demais.
        ...(Number.isFinite(delayMs) && delayMs > 0
          ? { delay: Math.min(15000, Math.floor(delayMs)) }
          : {}),
      }),
    });

    if (!response.ok) {
      // Consome body para liberar conexao
      const errorBody = await response.text().catch(() => "");
      throw new Error(`EVOLUTION_HTTP_${response.status}${errorBody ? `:${errorBody.slice(0, 120)}` : ""}`);
    }

    // Drena body para liberar conexao (resposta nao precisa ser parseada — sucesso = 2xx)
    await response.text().catch(() => {});

    markSuccess();

    // Registra a mensagem OUT no chat do operador (best-effort — falha aqui
    // não deve derrubar o envio).
    try {
      const { saveWhatsappMessageStandalone } = await import(
        "../../application/driver-outreach/whatsapp-messages.js"
      );
      await saveWhatsappMessageStandalone({
        instance: inst,
        direction: "out",
        externalId: null,
        phone: normalizedTo,
        text: String(text || ""),
        status: "sent",
        timestamp: new Date(),
        raw: { correlationId: correlationId || null },
      });
    } catch (persistErr) {
      // não falha o envio por causa da persistência
      logStructuredEvent("warn", "whatsapp.delivery.persist_failed", {
        context: "driver-outreach",
        correlationId: correlationId || null,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }

    logStructuredEvent("info", "whatsapp.delivery.success", {
      context: "driver-outreach",
      correlationId: correlationId || null,
      maskedPhone,
      durationMs: Date.now() - startedAt,
    });

    return { ok: true };
  } catch (error) {
    markFailure();

    logStructuredEvent("warn", "whatsapp.delivery.failure", {
      context: "driver-outreach",
      correlationId: correlationId || null,
      maskedPhone,
      error: error instanceof Error ? error.message : String(error),
      failures: circuitState.failures,
      circuitOpenUntil: circuitState.openUntil || null,
      durationMs: Date.now() - startedAt,
    });

    throw error;
  }
}

// ─── Utilitarios para tests ───────────────────────────────────────────────────

// ─── Gestão da instância (conectar/QR/status/logout) ──────────────────────────

async function evolutionRequest(method, path, body) {
  const token = getEvolutionToken();
  const res = await fetchWithTimeout(`${getEvolutionUrl()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", apikey: token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  const data = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();
  return { ok: res.ok, status: res.status, data, text };
}

/** Estado da conexão: 'open' | 'connecting' | 'close' | 'not_created' | 'unknown'. */
export async function getWhatsappConnectionState({ instance: reqInstance } = {}) {
  const instance = resolveInstance(reqInstance);
  const r = await evolutionRequest("GET", `/instance/connectionState/${instance}`);
  if (r.status === 404) return { instance, state: "not_created" };
  if (!r.ok) throw new Error(`EVOLUTION_HTTP_${r.status}`);
  return { instance, state: r.data?.instance?.state || r.data?.state || "unknown" };
}

// NÃO tratar `d.code` como pairingCode: `code` é o CONTEÚDO BRUTO do QR (string
// "2@..."), não o código de 8 caracteres que o operador digita. O pairingCode
// real só vem quando conectamos passando `?number=` (ver connectWhatsappInstance).
const extractQr = (d = {}) => ({
  state: d.instance?.state || d.state || null,
  qrBase64: d.base64 || d.qrcode?.base64 || null,
  pairingCode: d.pairingCode || d.qrcode?.pairingCode || null,
});

// ─── Cache do QR (Evolution v2 entrega o QR por WEBHOOK, não no REST) ──────────
const qrCache = new Map(); // instance -> { base64, pairingCode, ts }
const QR_TTL_MS = 120_000;

/** Chamado pelo receptor de webhook quando o Evolution emite QRCODE_UPDATED. */
export function cacheInstanceQr(instance, base64, pairingCode) {
  if (instance && base64) qrCache.set(instance, { base64, pairingCode: pairingCode || null, ts: Date.now() });
}
export function clearInstanceQr(instance) {
  qrCache.delete(instance);
}
function getCachedQr(instance) {
  const e = qrCache.get(instance);
  return e && Date.now() - e.ts < QR_TTL_MS ? e : null;
}

/** Configura o webhook da instância para receber QRCODE_UPDATED/CONNECTION_UPDATE. */
async function setInstanceWebhook(instance) {
  const url = process.env.EVOLUTION_WEBHOOK_URL?.trim();
  if (!url) return { ok: false, skipped: true };
  return evolutionRequest("POST", `/webhook/set/${instance}`, {
    webhook: {
      enabled: true,
      url,
      byEvents: false,
      base64: true,
      events: ["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT"],
    },
  }).catch(() => ({ ok: false }));
}

/**
 * Garante a instância, ativa o webhook e dispara a conexão. Dois modos:
 *
 *  - QR (padrão): o QR chega de forma assíncrona via webhook (Evolution v2) —
 *    aguardamos o cache ser preenchido. `qrBase64` volta null quando o gateway
 *    não gera o QR — a UI trata como erro.
 *  - CÓDIGO (sem câmera): quando `number` é informado, reiniciamos o socket e
 *    pedimos o pairingCode ao Evolution (vem direto no REST). O operador digita
 *    o código de 8 caracteres no WhatsApp do número (Aparelhos conectados →
 *    Conectar um aparelho → Conectar com número de telefone).
 *
 * @param {object} [args]
 * @param {string} [args.number] - telefone do número a parear (ativa o modo código)
 */
export async function connectWhatsappInstance({ number, instance: reqInstance } = {}) {
  const instance = resolveInstance(reqInstance);
  clearInstanceQr(instance);
  const digits = String(number || "").replace(/\D/g, "");

  // Garante a instância + webhook.
  let r = await evolutionRequest("GET", `/instance/connect/${instance}`);
  if (r.status === 404) {
    await evolutionRequest("POST", "/instance/create", {
      instanceName: instance,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    });
    await setInstanceWebhook(instance);
    r = await evolutionRequest("GET", `/instance/connect/${instance}`);
  } else {
    await setInstanceWebhook(instance);
  }
  if (!r.ok) throw new Error(`EVOLUTION_HTTP_${r.status}${r.text ? `:${r.text.slice(0, 120)}` : ""}`);

  let out = extractQr(r.data || {});
  if (out.state === "open") {
    return { instance, mode: digits ? "code" : "qr", state: "open", qrAvailable: false, pairingAvailable: false };
  }

  // ── Modo CÓDIGO (sem câmera) ──────────────────────────────────────────────
  if (digits) {
    // Com um QR já em andamento o Evolution devolve o QR, não um pairingCode.
    // Reiniciamos o socket (logout) e então connect?number gera o código.
    await logoutWhatsappInstance({ instance }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1500));
    const path = `/instance/connect/${instance}?number=${encodeURIComponent(digits)}`;
    let cr = await evolutionRequest("GET", path);
    out = extractQr(cr.data || {});
    for (let i = 0; i < 8 && !out.pairingCode && out.state !== "open"; i++) {
      await new Promise((res) => setTimeout(res, 1200));
      cr = await evolutionRequest("GET", path);
      out = extractQr(cr.data || {});
    }
    return {
      instance,
      mode: "code",
      pairingCode: out.pairingCode || null,
      qrBase64: out.qrBase64 || null,
      state: out.state,
      pairingAvailable: Boolean(out.pairingCode),
      qrAvailable: Boolean(out.qrBase64),
    };
  }

  // ── Modo QR (padrão): QR chega via webhook ────────────────────────────────
  for (let i = 0; i < 12 && !out.qrBase64 && out.state !== "open"; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const cached = getCachedQr(instance);
    if (cached) {
      out = { ...out, qrBase64: cached.base64 };
      break;
    }
  }
  return { instance, mode: "qr", ...out, qrAvailable: Boolean(out.qrBase64), pairingAvailable: false };
}

/** Logout (desassocia o número atual da instância). */
export async function logoutWhatsappInstance({ instance: reqInstance } = {}) {
  const instance = resolveInstance(reqInstance);
  const r = await evolutionRequest("DELETE", `/instance/logout/${instance}`);
  if (!r.ok && r.status !== 404) throw new Error(`EVOLUTION_HTTP_${r.status}`);
  return { ok: true, instance };
}

// ─── Utilitarios para tests ───────────────────────────────────────────────────

export function resetEvolutionClientStateForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
