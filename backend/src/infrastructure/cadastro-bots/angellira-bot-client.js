/**
 * Cliente HTTP para o sidecar angelira-bot (bots/angelira, porta 8765).
 *
 * O sidecar (FastAPI API-only) é o ponto único de cadastro de motorista,
 * proprietário e veículo no AngelLira. Este cliente roda no backend Node
 * e fala com ele via rede Docker (`http://angelira-bot:8765`).
 *
 * Diferente de `angellira-client.js` (que só consulta vigência via
 * /profile/query), este faz CADASTRO efetivo via /api/robo/*.
 *
 * Epic DC-111 / Sprint 1 / DC-114.
 */

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BOT_URL = "http://angelira-bot:8765";
// Test E2E (2026-05-28 / DC-111): cadastro de motorista com store_query do
// relatorio leva 30-90s em prod Angellira. 60s era apertado e timeoutava
// mesmo com o motorista sendo criado de fato (driver_id retornado mas nao
// colhido pelo Node). Subimos pra 180s.
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

// Circuit breaker compartilhado pelos métodos de cadastro (não inclui health).
// Se 3 chamadas seguidas falharem com 5xx ou timeout, abre por 60s.
const circuitState = {
  failures: 0,
  openUntil: 0,
};

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallbackValue;
  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getBaseUrl() {
  const raw = process.env.ANGELLIRA_BOT_URL?.trim();
  return (raw || DEFAULT_BOT_URL).replace(/\/$/, "");
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_BOT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function getFailureThreshold() {
  return parsePositiveIntegerEnv("ANGELLIRA_BOT_CIRCUIT_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}

function getCooldownMs() {
  return parsePositiveIntegerEnv("ANGELLIRA_BOT_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

function isCircuitOpen() {
  return circuitState.openUntil > Date.now();
}

function recordCircuitFailure(context) {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
  logStructuredEvent("warn", "angellira-bot.failure", {
    ...context,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
  });
}

function recordCircuitSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

/**
 * Erro estruturado retornado pelo cliente. Inclui:
 *   - `code`       — identificador estável (ex: 'OWNER_NAO_CADASTRADO')
 *   - `message`    — mensagem em pt-BR pronta pra UI
 *   - `httpStatus` — status do bot (200/4xx/5xx/0 timeout)
 *   - `etapa`      — etapa do flow Python (proprietario|cavalo|carreta|motorista|...)
 *   - `raw`        — payload bruto retornado pelo sidecar (debug)
 *   - `acao`       — ação sugerida (string curta pra UI)
 */
export class AngelliraBotError extends Error {
  constructor({ code, message, httpStatus, etapa, raw, acao }) {
    super(message);
    this.name = "AngelliraBotError";
    this.code = code;
    this.httpStatus = httpStatus ?? null;
    this.etapa = etapa ?? null;
    this.raw = raw ?? null;
    this.acao = acao ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      etapa: this.etapa,
      acao: this.acao,
      raw: this.raw,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Mapping de erros do sidecar Python → estrutura amigável pra UI
// ──────────────────────────────────────────────────────────────────────────

/**
 * Traduz response do sidecar (que pode vir como FastAPI HTTPException com
 * detail={etapa, erro, ...}) para `AngelliraBotError` com mensagem pt-BR.
 *
 * Convenções vindas do sidecar (ver bots/angelira/backend/main.py):
 *   - 400 + detail.etapa="owner_nao_informado"
 *   - 422 + detail.etapa="owner_nao_cadastrado"
 *   - 422 + detail.etapa="owner_generico_bloqueado"
 *   - 502 + detail{etapa, erro, ...}
 *   - 503 "AngelLira indisponivel: ..."
 */
function mapBotError({ httpStatus, body, fallbackMessage }) {
  const detail = body?.detail;
  const etapa = (detail && typeof detail === "object") ? detail.etapa : null;
  const erroMsg = (detail && typeof detail === "object") ? detail.erro : null;

  if (httpStatus === 503) {
    return new AngelliraBotError({
      code: "BOT_INDISPONIVEL",
      message: "Sidecar Angellira indisponível: credenciais ausentes ou serviço offline.",
      acao: "Verifique se o container angelira-bot está rodando e se as credenciais estão configuradas.",
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 422 && etapa === "owner_nao_cadastrado") {
    return new AngelliraBotError({
      code: "OWNER_NAO_CADASTRADO",
      message: erroMsg || "Proprietário não encontrado no Angellira.",
      acao: "Cadastre o proprietário (PF ou PJ) antes de cadastrar o veículo.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 422 && etapa === "owner_generico_bloqueado") {
    return new AngelliraBotError({
      code: "OWNER_GENERICO_BLOQUEADO",
      message: erroMsg || "Owner genérico bloqueado por política estrita.",
      acao: "Use owner real (com CPF/CNPJ válidos), não fallback GRIFFI.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 400 && etapa === "owner_nao_informado") {
    return new AngelliraBotError({
      code: "OWNER_NAO_INFORMADO",
      message: erroMsg || "Proprietário do veículo não informado.",
      acao: "Informe owner_cpf ou owner_cnpj.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 502 && etapa === "owner_lookup_falhou") {
    return new AngelliraBotError({
      code: "OWNER_LOOKUP_FALHOU",
      message: erroMsg || "Erro consultando Angellira para resolver proprietário.",
      acao: "Tente novamente em alguns segundos. Se persistir, verifique o painel do Angellira.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 502) {
    return new AngelliraBotError({
      code: "BOT_DOWNSTREAM_FAIL",
      message: erroMsg || `Falha no Angellira (etapa: ${etapa || "?"}).`,
      acao: "Tente novamente. Se persistir, contate o suporte com o código do erro.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus === 400) {
    return new AngelliraBotError({
      code: "BOT_BAD_REQUEST",
      message: typeof detail === "string"
        ? detail
        : (erroMsg || "Dados do cadastro são inválidos."),
      acao: "Revise os dados do motorista/veículo e tente novamente.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  if (httpStatus >= 500 || httpStatus === 0) {
    return new AngelliraBotError({
      code: "BOT_UNAVAILABLE",
      message: fallbackMessage || "Sidecar Angellira não respondeu.",
      acao: "Aguarde alguns segundos e tente novamente.",
      etapa,
      httpStatus,
      raw: body,
    });
  }

  return new AngelliraBotError({
    code: "BOT_UNKNOWN_ERROR",
    message: fallbackMessage || `HTTP ${httpStatus} inesperado do sidecar.`,
    acao: "Contate o suporte com este código.",
    etapa,
    httpStatus,
    raw: body,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP helper
// ──────────────────────────────────────────────────────────────────────────

/**
 * Faz POST/GET no sidecar com timeout e retry de 1 tentativa em 5xx/timeout.
 * Não faz retry em 4xx (erro do payload — retentar não muda o resultado).
 *
 * @param {object} args
 * @param {"GET"|"POST"} args.method
 * @param {string} args.path     — ex: /api/robo/motorista_api/iniciar
 * @param {object} [args.body]   — JSON body (POST)
 * @param {string} [args.idempotencyKey]
 * @param {string} [args.correlationId]
 * @returns {Promise<{httpStatus: number, body: any}>}
 */
async function request({ method, path, body, idempotencyKey, correlationId }) {
  if (isCircuitOpen()) {
    throw new AngelliraBotError({
      code: "BOT_CIRCUIT_OPEN",
      message: "Sidecar Angellira temporariamente bloqueado (muitas falhas seguidas).",
      acao: "Aguarde ~1 minuto e tente novamente.",
      httpStatus: 0,
    });
  }

  const url = `${getBaseUrl()}${path}`;
  const timeoutMs = getTimeoutMs();
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (correlationId) headers["X-Correlation-Id"] = correlationId;

  const fetchOnce = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      let parsed = null;
      const text = await response.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { detail: text.slice(0, 500) };
        }
      }
      logStructuredEvent("info", "angellira-bot.request", {
        path,
        method,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        correlationId: correlationId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        ok: response.ok,
      });
      return { httpStatus: response.status, body: parsed };
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err?.name === "AbortError";
      const errorMsg = err instanceof Error ? err.message : String(err);
      logStructuredEvent("warn", "angellira-bot.request_failed", {
        path,
        method,
        durationMs: Date.now() - startedAt,
        correlationId: correlationId ?? null,
        timeout: isTimeout,
        message: errorMsg,
      });
      // ConnectionRefused, DNS, timeout — todos tratados como 0
      return { httpStatus: 0, body: { detail: isTimeout ? "timeout" : errorMsg } };
    }
  };

  // Tentativa 1
  let result = await fetchOnce();

  // Retry 1x em 5xx/timeout (4xx não — payload errado, retentar não ajuda)
  if (result.httpStatus === 0 || result.httpStatus >= 500) {
    await new Promise((r) => setTimeout(r, 500));
    result = await fetchOnce();
  }

  // Circuito
  if (result.httpStatus === 0 || result.httpStatus >= 500) {
    recordCircuitFailure({ path, method, httpStatus: result.httpStatus, correlationId });
  } else {
    recordCircuitSuccess();
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// API pública
// ──────────────────────────────────────────────────────────────────────────

/**
 * Health do sidecar — leve, sem retry, sem circuit breaker (queremos
 * exatamente saber se está online).
 */
export async function health() {
  const url = `${getBaseUrl()}/api/status`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const body = await response.json().catch(() => null);
    return { ok: response.ok, httpStatus: response.status, body };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      httpStatus: 0,
      body: { detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Cadastra motorista. Payload espelha o que o sidecar espera:
 *   { motorista: {nome, cpf, ...}, cnh: {...}, endereco: {...} }
 *
 * @param {object} args
 * @param {string} args.idCadastro      — UUID do pending_driver_registrations
 * @param {object} args.payload         — { motorista, cnh, endereco }
 * @param {object} [args.anexos]        — { cnh_frente_path, cnh_verso_path, ... }
 * @param {number} [args.typeId=25]     — 25=Funcionario, 26=Agregado
 * @param {number} [args.prime=0]
 * @param {string} [args.correlationId]
 * @returns {Promise<{ok:true, driverId:string, queryId?:string, raw:any}>}
 * @throws {AngelliraBotError}
 */
export async function cadastrarMotorista({
  idCadastro,
  payload,
  anexos = {},
  typeId = 25,
  prime = 0,
  correlationId,
}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/api/robo/motorista_api/iniciar",
    body: {
      id_cadastro: idCadastro || "",
      payload,
      anexos,
      type_id: typeId,
      prime,
    },
    idempotencyKey: idCadastro ? `${idCadastro}:motorista` : undefined,
    correlationId,
  });

  if (httpStatus === 200 && body?.ok) {
    return {
      ok: true,
      driverId: body.driverId ?? body.driver_id ?? null,
      queryId: body.queryId ?? body.query_id ?? null,
      raw: body,
    };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao cadastrar motorista no Angellira." });
}

/**
 * Cadastra proprietário (PF ou PJ).
 *
 * @param {object} args
 * @param {string} args.idCadastro
 * @param {"PF"|"PJ"} args.tipo
 * @param {object} args.payload   — {cnpj/cpf, razao_social/nome, telefone, endereco}
 * @param {object} [args.anexos]
 * @param {number} [args.relationship=1]
 * @param {string} [args.correlationId]
 * @returns {Promise<{ok:true, ownerId:string, raw:any}>}
 * @throws {AngelliraBotError}
 */
export async function cadastrarProprietario({
  idCadastro,
  tipo,
  payload,
  anexos = {},
  relationship = 1,
  correlationId,
}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/api/robo/proprietario_api/iniciar",
    body: {
      id_cadastro: idCadastro || "",
      tipo,
      payload,
      anexos,
      relationship,
    },
    idempotencyKey: idCadastro ? `${idCadastro}:proprietario:${tipo}` : undefined,
    correlationId,
  });

  if (httpStatus === 200 && body?.ok) {
    return {
      ok: true,
      ownerId: body.ownerId ?? body.owner_id ?? null,
      raw: body,
    };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao cadastrar proprietário no Angellira." });
}

/**
 * Cadastra veículo (cavalo ou carreta). Requer owner real já cadastrado.
 *
 * @param {object} args
 * @param {string} args.idCadastro
 * @param {"cavalo"|"carreta"} args.sub
 * @param {object} args.payload   — {placa, renavam, chassi, marca_modelo, ano_fab, ...}
 * @param {string} [args.ownerCpf]
 * @param {string} [args.ownerCnpj]
 * @param {number} [args.ownerId=0]
 * @param {object} [args.anexos]
 * @param {number} [args.relationship=1]
 * @param {number} [args.prime=0]
 * @param {string} [args.correlationId]
 * @returns {Promise<{ok:true, vehicleId:string, queryId?:string, raw:any}>}
 * @throws {AngelliraBotError}  // OWNER_NAO_CADASTRADO se owner não existe
 */
export async function cadastrarVeiculo({
  idCadastro,
  sub,
  payload,
  ownerCpf = "",
  ownerCnpj = "",
  ownerId = 0,
  anexos = {},
  relationship = 1,
  prime = 0,
  correlationId,
}) {
  const placa = (payload?.placa || payload?.[sub]?.placa || "").toString().toUpperCase();
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/api/robo/veiculo_api/iniciar",
    body: {
      id_cadastro: idCadastro || "",
      sub,
      payload,
      anexos,
      owner_cpf: ownerCpf,
      owner_cnpj: ownerCnpj,
      owner_id: ownerId,
      relationship,
      prime,
    },
    idempotencyKey: idCadastro && placa ? `${idCadastro}:veiculo:${sub}:${placa}` : undefined,
    correlationId,
  });

  if (httpStatus === 200 && body?.ok) {
    return {
      ok: true,
      vehicleId: body.vehicleId ?? body.vehicle_id ?? null,
      queryId: body.queryId ?? body.query_id ?? null,
      raw: body,
    };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: `Falha ao cadastrar ${sub} no Angellira.` });
}

/**
 * Pre-check de owner divergente. NÃO escreve nada — só consulta.
 * Retorna o payload bruto pra UI decidir se mostra modal de confirmação.
 *
 * @param {object} args
 * @param {string} args.placa
 * @param {string} [args.expectedCpf]
 * @param {string} [args.expectedCnpj]
 * @param {"PF"|"PJ"} [args.expectedTipo]
 * @param {string} [args.correlationId]
 * @returns {Promise<object>}  // ver shape em RELATORIO_CADASTRO.md §2.6
 */
export async function checkOwner({
  placa,
  expectedCpf = "",
  expectedCnpj = "",
  expectedTipo = "",
  correlationId,
}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/api/robo/veiculo_api/check_owner",
    body: {
      placa,
      expected_cpf: expectedCpf,
      expected_cnpj: expectedCnpj,
      expected_tipo: expectedTipo,
    },
    correlationId,
  });

  if (httpStatus === 200) {
    return body;
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao consultar owner do veículo." });
}

/**
 * Reset interno (testes). Não exportar em produção.
 */
export function __resetCircuitForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
