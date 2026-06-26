/**
 * Cliente HTTP para o sidecar spx-bot (bots/spx, porta 8766).
 *
 * O sidecar (FastAPI) cadastra motoristas no portal SPX (Shopee Express)
 * usando cookies SSO lidos do Supabase (tabela aspx_credentials, renovados
 * pelo container aspx-renewal a cada 4 dias via Playwright).
 *
 * Diferente do angellira-bot-client, este NÃO cadastra owner ou veículo
 * (SPX só tem cadastro de motorista; placa entra como dado dentro do
 * payload).
 *
 * Epic DC-111 / Sprint 1 extensão SPX.
 */

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const DEFAULT_BOT_URL = "http://spx-bot:8766";
// Cadastros SPX podem incluir uploads multipart + 8 chamadas seriadas
// (is_cpf_exist, validate/basic, validate/detail, draft/save, submit/check,
// submit, list, detail). Pra ficar com folga, 180s.
const DEFAULT_TIMEOUT_MS = 180_000;
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
  return (process.env.SPX_BOT_URL?.trim() || DEFAULT_BOT_URL).replace(/\/$/, "");
}
function getTimeoutMs() {
  return parsePositiveIntegerEnv("SPX_BOT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}
function getFailureThreshold() {
  return parsePositiveIntegerEnv("SPX_BOT_CIRCUIT_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
}
function getCooldownMs() {
  return parsePositiveIntegerEnv("SPX_BOT_CIRCUIT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

function isCircuitOpen() { return circuitState.openUntil > Date.now(); }
function recordCircuitFailure(context) {
  circuitState.failures += 1;
  if (circuitState.failures >= getFailureThreshold()) {
    circuitState.openUntil = Date.now() + getCooldownMs();
  }
  logStructuredEvent("warn", "spx-bot.failure", {
    ...context,
    failureCount: circuitState.failures,
    circuitOpenUntil: circuitState.openUntil || null,
  });
}
function recordCircuitSuccess() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}

export class SpxBotError extends Error {
  constructor({ code, message, httpStatus, etapa, raw, acao, retcode }) {
    super(message);
    this.name = "SpxBotError";
    this.code = code;
    this.httpStatus = httpStatus ?? null;
    this.etapa = etapa ?? null;
    this.raw = raw ?? null;
    this.acao = acao ?? null;
    this.retcode = retcode ?? null;
  }
  toJSON() {
    return {
      code: this.code, message: this.message, httpStatus: this.httpStatus,
      etapa: this.etapa, acao: this.acao, retcode: this.retcode, raw: this.raw,
    };
  }
}

/**
 * Mapping de erros do sidecar SPX → mensagens pt-BR.
 *
 * Retcodes principais (bots/spx/backend/spx_robo/constants.py):
 *   271605007  CPF inválido
 *   271605009  Telefone inválido
 *   271605028  REQUEST_IN_PROGRESS — já existe solicitação aberta
 *   271605004  Driver inativo — precisa /ativar
 *   271627140  CPF já cadastrado (DRIVER_REPEAT)
 *   271617003  DRIVER_BLOCKED — bloqueado
 *   991900001  OCR não extraiu CRLV
 *   991900013..18 Erros de upload
 */
function mapBotError({ httpStatus, body, fallbackMessage }) {
  const detail = body?.detail;
  const detailObj = (detail && typeof detail === "object") ? detail : null;
  const retcode = detailObj?.retcode || body?.retcode || null;
  const etapa = detailObj?.etapa || body?.etapa || null;
  const erroMsg = detailObj?.erro || body?.erro || null;

  if (httpStatus === 401) {
    return new SpxBotError({
      code: "SPX_SESSAO_EXPIRADA",
      message: typeof detail === "string" ? detail : "Sessão SPX expirada — cookies inválidos.",
      acao: "Aguarde o container aspx-renewal renovar (próxima iteração) ou rode manualmente.",
      httpStatus, etapa, raw: body,
    });
  }
  if (retcode === 271605028) {
    return new SpxBotError({
      code: "SPX_REQUEST_IN_PROGRESS",
      message: "Já existe solicitação aberta no SPX para este CPF.",
      acao: "Use /spx/motorista/atualizar ou aguarde a request existente ser processada.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271627140) {
    return new SpxBotError({
      code: "SPX_DRIVER_REPEAT",
      message: "CPF já cadastrado e ativo no SPX.",
      acao: "Nenhuma ação necessária — motorista já existe.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271605004) {
    return new SpxBotError({
      code: "SPX_DRIVER_INATIVO",
      message: "Motorista existe no SPX mas está inativo.",
      acao: "Use /spx/motorista/ativar para reativar.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271617003) {
    return new SpxBotError({
      code: "SPX_DRIVER_BLOQUEADO",
      message: "Motorista bloqueado no SPX.",
      acao: "Contate a Shopee Express — desbloqueio só pelo portal.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271605007) {
    return new SpxBotError({
      code: "SPX_CPF_INVALIDO",
      message: erroMsg || "CPF inválido segundo o SPX.",
      acao: "Verifique se o CPF está correto.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271605009) {
    return new SpxBotError({
      code: "SPX_TELEFONE_INVALIDO",
      message: erroMsg || "Telefone inválido segundo o SPX.",
      acao: "Verifique se o telefone tem 11 dígitos.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271626003) {
    return new SpxBotError({
      code: "SPX_VALIDATE_DETAIL_REJECTED",
      message: erroMsg || "SPX rejeitou os dados do veículo (validate/detail).",
      acao: "Verifique: (1) a categoria da CNH permite o veículo (cavalo exige E — AE/BE/CE/DE/E); "
        + "(2) a placa não está em uso por outro motorista; (3) vehicle_type/placa/renavam batem com o OCR do CRLV.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271690000) {
    return new SpxBotError({
      code: "SPX_DADOS_INVALIDOS",
      message: erroMsg || "Dados inválidos no envio ao SPX.",
      acao: "vehicle_manufacturer deve bater 1:1 com o CRLV (só a marca, ex.: 'VOLVO', não 'VOLVO/FH 400'); se for importação de outra agência, o perfil pode ter vindo vazio.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271605029) {
    // SPX aninha o motivo real (ex.: 103702008 "This car plate is attached to
    // another RENAVAM"). Conflito de DADO no cadastro de veículos do SPX, não nosso.
    const placaConflito = /attached to another RENAVAM|103702008/i.test(String(erroMsg || ""));
    return new SpxBotError({
      code: "SPX_VEHICLE_PARAM_INVALIDO",
      message: erroMsg || "Parâmetro de veículo inválido no SPX.",
      acao: placaConflito
        ? "A placa já está vinculada a OUTRO RENAVAM no cadastro de veículos do SPX (foi cadastrada antes com renavam diferente). Confira placa/renavam no CRLV — se estiverem corretos, contate a Shopee ops para ajustar o veículo no SPX."
        : "Parâmetro de veículo rejeitado pelo SPX. Confira placa/renavam/tipo do veículo contra o CRLV; se persistir, contate a Shopee ops.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (retcode === 271606027) {
    // SPX/Shopee rejeita veículo com mais de 20 anos de fabricação (validate/detail).
    // O cadastro fica salvo como RASCUNHO (save_draft cria a request) mas NÃO submete
    // — por isso aparece como "solicitação pendente"/editável sem nunca ser aprovado.
    // Descoberto no teste do FLAVIO (SCANIA 1995/1996, ~31 anos). 2026-06-25.
    return new SpxBotError({
      code: "SPX_VEICULO_MUITO_ANTIGO",
      message: erroMsg || "Veículo com mais de 20 anos — a Shopee não aceita.",
      acao: "A Shopee/SPX só aceita veículos com até 20 anos de fabricação. O cadastro ficou "
        + "salvo como RASCUNHO mas NÃO foi submetido com este veículo. Não há como concluir o "
        + "SPX com um cavalo/carreta acima do limite de idade.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (httpStatus === 502) {
    return new SpxBotError({
      code: "SPX_DOWNSTREAM_FAIL",
      message: erroMsg || `Falha SPX em ${etapa || "etapa desconhecida"}.`,
      acao: "Tente novamente. Se persistir, contate suporte com este código.",
      httpStatus, etapa, retcode, raw: body,
    });
  }
  if (httpStatus === 503) {
    return new SpxBotError({
      code: "SPX_BOT_INDISPONIVEL",
      message: "Sidecar SPX indisponível.",
      acao: "Verifique container spx-bot e cookies no Supabase.",
      httpStatus, raw: body,
    });
  }
  if (httpStatus === 400) {
    return new SpxBotError({
      code: "SPX_BAD_REQUEST",
      message: typeof detail === "string" ? detail : (erroMsg || "Dados inválidos."),
      acao: "Revise os dados do motorista.",
      httpStatus, etapa, raw: body,
    });
  }
  if (httpStatus >= 500 || httpStatus === 0) {
    return new SpxBotError({
      code: "SPX_BOT_UNAVAILABLE",
      message: fallbackMessage || "Sidecar SPX não respondeu.",
      acao: "Aguarde alguns segundos e tente novamente.",
      httpStatus, raw: body,
    });
  }
  return new SpxBotError({
    code: "SPX_UNKNOWN_ERROR",
    // 2026-06-25: mostra o MOTIVO REAL que o SPX retornou (erroMsg) em vez de uma
    // mensagem genérica — assim, mesmo p/ retcodes ainda não mapeados, o operador
    // entende o porquê (ex.: "A idade do veículo não pode ser superior a 20 anos")
    // em vez de só "Contate o suporte".
    message: erroMsg || fallbackMessage || `HTTP ${httpStatus} inesperado do sidecar SPX.`,
    acao: retcode
      ? `O SPX recusou com o código ${retcode}. Veja o motivo acima; se não resolver, contate a Shopee com esse código.`
      : "Contate o suporte com este código.",
    httpStatus, etapa, retcode, raw: body,
  });
}

async function request({ method, path, body, idempotencyKey, correlationId }) {
  if (isCircuitOpen()) {
    throw new SpxBotError({
      code: "SPX_BOT_CIRCUIT_OPEN",
      message: "Sidecar SPX temporariamente bloqueado (muitas falhas seguidas).",
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
      const text = await response.text();
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { detail: text.slice(0, 500) }; }
      }
      logStructuredEvent("info", "spx-bot.request", {
        path, method, httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        correlationId: correlationId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        ok: response.ok,
      });
      return { httpStatus: response.status, body: parsed };
    } catch (err) {
      clearTimeout(t);
      const isTimeout = err?.name === "AbortError";
      const errorMsg = err instanceof Error ? err.message : String(err);
      logStructuredEvent("warn", "spx-bot.request_failed", {
        path, method,
        durationMs: Date.now() - startedAt,
        correlationId: correlationId ?? null,
        timeout: isTimeout,
        message: errorMsg,
      });
      return { httpStatus: 0, body: { detail: isTimeout ? "timeout" : errorMsg } };
    }
  };

  let result = await fetchOnce();
  if (result.httpStatus === 0 || result.httpStatus >= 500) {
    await new Promise((r) => setTimeout(r, 500));
    result = await fetchOnce();
  }
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

export async function status() {
  const url = `${getBaseUrl()}/spx/status`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const body = await response.json().catch(() => null);
    return { ok: response.ok, httpStatus: response.status, body };
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false, httpStatus: 0,
      body: { detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Lookup leve por CPF — read-only, sem efeitos colaterais no SPX.
 * Retorna se o motorista já existe (na nossa agência ou em outra), incluindo
 * dados básicos quando is_matched=true.
 *
 * @param {object} args
 * @param {string} args.cpf
 * @param {string} [args.driverName]
 * @param {string} [args.contactNumber]
 * @returns {Promise<{
 *   ok: boolean, encontrado: boolean, is_matched?: boolean,
 *   driver_info?: object, existing_driver_id?: number,
 *   na_minha_agencia?: boolean, requests_nossa_agencia_count?: number,
 *   raw: any
 * }>}
 */
export async function lookupMotorista({
  cpf, driverName = "", contactNumber = "", licenseNumber = "", correlationId,
}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/motorista/lookup",
    body: {
      cpf,
      driver_name: driverName,
      contact_number: contactNumber,
      license_number: licenseNumber,
    },
    correlationId,
  });
  if (httpStatus === 200 && body?.ok != null) {
    return { ...body, raw: body };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao consultar motorista SPX." });
}

/**
 * Diagnóstico passivo — checa se motorista existe + se está em outra agência.
 * Mais informativo que lookup, sem riscar travar o motorista com placa errada.
 */
export async function diagnostico({ cpf, placaNossa = "", correlationId }) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/motorista/diagnostico",
    body: { cpf, placa_nossa: placaNossa },
    correlationId,
  });
  if (httpStatus === 200) return { ...body, raw: body };
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha no diagnóstico SPX." });
}

/**
 * Cadastra motorista no SPX (fluxo completo: is_cpf_exist → validate →
 * uploads → submit). Para casos onde já existe request, use lookupMotorista
 * antes e decida entre importar_matched / atualizar / pular.
 *
 * @param {object} payload — formato MotoristaPayload do bot SPX
 * @param {string} [args.correlationId]
 * @param {string} [args.idempotencyKey]
 */
export async function cadastrarMotorista({ payload, idempotencyKey, correlationId }) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/motorista",
    body: payload,
    idempotencyKey,
    correlationId,
  });
  if (httpStatus === 200 && body?.ok) {
    return {
      ok: true,
      etapa: body.etapa,
      requestId: body.request_id ?? body.requestId ?? null,
      driverId: body.driver_id ?? body.driverId ?? null,
      raw: body,
    };
  }
  // SPX retorna 200 com ok:false em alguns cenários (REQUEST_IN_PROGRESS).
  // Tratamos como erro estruturado.
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao cadastrar motorista no SPX." });
}

/**
 * Importa driver_profile já existente (em outra agência) criando request NOSSA.
 * Reusa locked_fields (CNH, foto, RG, endereço). Só Risk Doc + linehaul +
 * vehicle podem ser fornecidos.
 */
export async function importarMatched({
  cpf, driverInfo,
  contractType = 364, functionTypeList,
  linehaulStationName, pickupStationName, deliveryStationName, returnStationName,
  vehicleTypeName, licensePlate, renavam, vehicleManufacturer, vehicleManufacturingYear,
  vehicleOwnerName,
  crlvPath, riskDocPath, radExpireDate,
  cityNameFallback,
  dryRun = false, doDraftSave = false,
  idempotencyKey, correlationId,
}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/motorista/importar_matched",
    body: {
      cpf,
      driver_info: driverInfo,
      contract_type: contractType,
      function_type_list: functionTypeList,
      linehaul_station_name: linehaulStationName,
      pickup_station_name: pickupStationName,
      delivery_station_name: deliveryStationName,
      return_station_name: returnStationName,
      vehicle_type_name: vehicleTypeName,
      license_plate: licensePlate,
      renavam,
      vehicle_manufacturer: vehicleManufacturer,
      vehicle_manufacturing_year: vehicleManufacturingYear,
      vehicle_owner_name: vehicleOwnerName,
      crlv_path: crlvPath,
      risk_doc_path: riskDocPath,
      rad_expire_date: radExpireDate,
      dry_run: dryRun,
      do_draft_save: doDraftSave,
      city_name_fallback: cityNameFallback || null,
    },
    idempotencyKey,
    correlationId,
  });
  if (httpStatus === 200 && body?.ok) {
    return { ok: true, ...body, raw: body };
  }
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao importar motorista SPX." });
}

/** Ativa driver_profile inativo (retcode 271605004). */
export async function ativarDriver({ driverId, correlationId }) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/motorista/ativar",
    body: { driver_id: driverId },
    correlationId,
  });
  if (httpStatus === 200 && body?.ok) return { ok: true, raw: body };
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao ativar driver SPX." });
}

/** Força recarga de cookies (após renovação manual). */
export async function resetSession({ correlationId } = {}) {
  const { httpStatus, body } = await request({
    method: "POST",
    path: "/spx/session/reset",
    correlationId,
  });
  if (httpStatus === 200) return { ok: true, raw: body };
  throw mapBotError({ httpStatus, body, fallbackMessage: "Falha ao resetar sessão SPX." });
}

export function __resetCircuitForTests() {
  circuitState.failures = 0;
  circuitState.openUntil = 0;
}
