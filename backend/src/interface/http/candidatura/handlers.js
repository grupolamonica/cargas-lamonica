import "../../../infrastructure/config/load-env.js";

import { ZodError } from "zod";

import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { requireDriverSession } from "../../../application/load-claims/auth.js";
import { resolveCandidaturaActor } from "../../../application/load-claims/candidatura-actor.js";
import { getDriverProfileByUserId } from "../../../application/load-claims/profile-service.js";
import { candidaturaPreCheck } from "../../../application/candidatura/use-cases/pre-check.js";
import { saveCandidaturaDraft } from "../../../application/candidatura/use-cases/save-draft.js";
import { saveCandidaturaDraftByCpf } from "../../../application/candidatura/use-cases/save-draft-by-cpf.js";
import {
  getCandidaturaDraft,
  getCandidaturaDraftByCpf,
} from "../../../application/candidatura/use-cases/get-draft.js";
import { listIncompleteCadastroDrafts } from "../../../application/candidatura/use-cases/list-incomplete-drafts.js";
import { submitCandidaturaFinal } from "../../../application/candidatura/use-cases/submit-final.js";
import { resolveAnttCascade } from "../../../application/candidatura/use-cases/antt-cascade.js";
import { verifyDocument } from "../../../application/candidatura/use-cases/verify-document.js";
import { getExistingMotorista } from "../../../application/candidatura/use-cases/get-existing-motorista.js";
import { getExistingCavalo } from "../../../application/candidatura/use-cases/get-existing-cavalo.js";
import {
  getAuthorizationHeader,
  getCorrelationId,
  getHeaderValue,
  getQueryParam,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import {
  buildMissingFieldsMessage,
  candidaturaAnttPrecheckSchema,
  candidaturaDraftSchema,
  candidaturaPreCheckSchema,
  candidaturaSubmitSchema,
  candidaturaVerifyDocumentSchema,
} from "../schemas/candidatura-schemas.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";

// Rate-limit por IP: maximo 10 requisicoes por IP por 60 segundos para handlers
// gerais (draft save/get, submit, antt-precheck). Pre-check usa limiter dedicado
// mais estrito (5/min, alinhado com verify-document).
// Evita exaustao de quota Angellira/ASPX sem bloquear motoristas em redes compartilhadas (CGNAT).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const ipRateLimitMap = new Map();

// A5 fix — Rate-limit dedicado para /pre-check (5/min/IP, anti-enumeration).
// Pre-check tambem expoe sinal sobre existencia de CPF/placa via pendencias[],
// portanto recebe o mesmo budget de verify-document.
const PRE_CHECK_WINDOW_MS = 60_000;
const PRE_CHECK_MAX = 5;
const preCheckRateMap = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, value] of ipRateLimitMap) {
    if (value.resetAt <= cutoff) ipRateLimitMap.delete(key);
  }
}, 60_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of preCheckRateMap) {
    if (value.resetAt <= now) preCheckRateMap.delete(key);
  }
}, 60_000).unref();

function checkPreCheckRateLimit(ip) {
  if (!ip) return { limited: false, retryAfterSeconds: 0 };
  const now = Date.now();
  const entry = preCheckRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    preCheckRateMap.set(ip, { count: 1, resetAt: now + PRE_CHECK_WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  entry.count += 1;
  if (entry.count > PRE_CHECK_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { limited: true, retryAfterSeconds };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

function maskCpf(rawCpf) {
  const digits = String(rawCpf || "").replace(/\D/g, "");
  if (digits.length === 0) return "***";
  return `${digits.slice(0, 3)}***`;
}

function isRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// Rate-limit dedicado para /verify-document — 5 req/min/IP (anti-enumeration
// de CPF/placa). Stricter que o limiter geral porque o endpoint e publico e
// permite probing de cadastros existentes.
// Limitacao conhecida: in-memory, nao cluster-safe. Em deploy multi-replica
// cada instancia tem seu proprio map (motorista pode fazer ~5*N req antes de
// bloquear). Aceitavel pra v1; upgrade futuro: Redis ou rate-limiter-flexible.
const VERIFY_DOC_WINDOW_MS = 60_000;
const VERIFY_DOC_MAX = 5;
const verifyDocRateMap = new Map();

setInterval(() => {
  const cutoff = Date.now() - VERIFY_DOC_WINDOW_MS;
  for (const [key, value] of verifyDocRateMap) {
    if (value.resetAt <= cutoff) verifyDocRateMap.delete(key);
  }
}, 60_000).unref();

/**
 * Bug 7 fix — detecta se `dados.motorista` veio incompleto (Step A pulado no wizard
 * por motorista ja cadastrado). Campos obrigatorios por `motoristaSchema`:
 * nome, telefones, telefone_primario, endereco, tag_pedagio, pancary_autodeclaration.
 */
function isMotoristaPartial(motorista) {
  if (!motorista || typeof motorista !== "object") return true;
  if (!motorista.nome) return true;
  if (!Array.isArray(motorista.telefones) || motorista.telefones.length === 0) return true;
  if (!motorista.telefone_primario) return true;
  if (!motorista.endereco || typeof motorista.endereco !== "object") return true;
  if (!motorista.endereco.cep || !motorista.endereco.numero || !motorista.endereco.logradouro) {
    return true;
  }
  // Skip-Step-B fix — tag_pedagio + pancary_autodeclaration sao opcionais
  // (coletados no Step B do wizard, pulado quando cavalo vigente). Quando
  // ausentes, dispara merge com motorista persistido pra reidratar se houver.
  if (!motorista.tag_pedagio) return true;
  if (!motorista.pancary_autodeclaration) return true;
  return false;
}

/**
 * Merge defensivo: campos enviados pelo cliente tem prioridade; ausentes sao
 * preenchidos do motorista persistido. `cnh` e `rastreador` (objetos) tambem
 * sao mesclados se nao vierem no payload.
 */
function mergeMotorista(existing, incoming) {
  const safe = (incoming && typeof incoming === "object") ? incoming : {};
  const base = existing || {};
  return {
    ...base,
    ...safe,
    endereco: safe.endereco || base.endereco,
    telefones: Array.isArray(safe.telefones) && safe.telefones.length > 0
      ? safe.telefones
      : base.telefones,
    cnh: safe.cnh || base.cnh,
    rastreador: safe.rastreador || base.rastreador,
  };
}

/**
 * Skip-Step-B fix — detecta se `dados.cavalo` veio incompleto (Step B pulado
 * porque a placa ja tem cadastro vigente). Campos obrigatorios por
 * `cavaloSchema`: placa, owner_doc, owner_doc_type.
 */
function isCavaloPartial(cavalo) {
  if (!cavalo || typeof cavalo !== "object") return true;
  if (!cavalo.placa) return true;
  if (!cavalo.owner_doc) return true;
  if (!cavalo.owner_doc_type) return true;
  return false;
}

/**
 * Merge defensivo do cavalo: campos enviados pelo cliente tem prioridade;
 * ausentes sao preenchidos do veiculo persistido. Mesmo padrao do
 * mergeMotorista.
 */
function mergeCavalo(existing, incoming) {
  const safe = (incoming && typeof incoming === "object") ? incoming : {};
  const base = existing || {};
  return { ...base, ...safe };
}

function checkVerifyDocRateLimit(ip) {
  if (!ip) return { limited: false, retryAfterSeconds: 0 };
  const now = Date.now();
  const entry = verifyDocRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    verifyDocRateMap.set(ip, { count: 1, resetAt: now + VERIFY_DOC_WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  entry.count += 1;
  if (entry.count > VERIFY_DOC_MAX) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { limited: true, retryAfterSeconds };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * Mascara o `value` recebido para logging audit — evita expor PII no console.
 *   - cpf: mostra 3 primeiros digitos + ***
 *   - placa: mostra 3 primeiras letras + ***
 *   - fallback: ***
 */
function maskVerifyDocumentValue(type, rawValue) {
  const value = String(rawValue || "");
  if (type === "cpf" || type === "ownerCpf" || type === "ownerCnpj") {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 0) return "***";
    return `${digits.slice(0, 3)}***`;
  }
  if (type === "horsePlate" || type === "trailerPlate") {
    const upper = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (upper.length === 0) return "***";
    return `${upper.slice(0, 3)}***`;
  }
  return "***";
}

/**
 * POST /api/candidatura/pre-check
 * Endpoint PUBLICO (sem auth) — motoristas nao precisam de login/senha.
 * Reusa validatePublicLeadPreRegistration (Angellira+ASPX+vigencia 20d)
 * e retorna { pendencias[], completos[] } para a Tela 0 do wizard.
 *
 * CPF vem do body (form do DriverClaimPanel).
 */
export async function resolveCandidaturaPreCheckResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  // A5 fix — rate-limit dedicado 5/min/IP (anti-enumeration), alinhado com
  // verify-document. Pre-check leaka existencia de CPF/placa via pendencias[].
  const { limited, retryAfterSeconds } = checkPreCheckRateLimit(requestIp);
  if (limited) {
    console.info("[candidatura.pre-check.audit]", {
      correlationId,
      ip: requestIp || "unknown",
      outcome: "rate_limited",
      retryAfterSeconds,
    });
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        retryAfterSeconds,
        meta: { correlationId },
      },
    };
  }

  // Body parse + zod.
  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  let parsedInput;
  try {
    parsedInput = candidaturaPreCheckSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }

  const cpfMasked = maskCpf(parsedInput.cpf);

  try {
    const { pendencias, completos } = await candidaturaPreCheck({
      driverCpf: parsedInput.cpf,
      horsePlate: parsedInput.horsePlate,
      trailerPlates: parsedInput.trailerPlates,
      correlationId,
      cacheOnly: parsedInput.preferCache === true,
    });

    // A5 fix — audit estruturado por requisicao (sucesso).
    console.info("[candidatura.pre-check.audit]", {
      correlationId,
      ip: requestIp || "unknown",
      cpfMasked,
      outcome: "success",
      pendenciasCount: pendencias?.length ?? 0,
      completosCount: completos?.length ?? 0,
    });

    return {
      statusCode: 200,
      payload: {
        pendencias,
        completos,
        meta: { correlationId },
      },
    };
  } catch (err) {
    console.info("[candidatura.pre-check.audit]", {
      correlationId,
      ip: requestIp || "unknown",
      cpfMasked,
      outcome: "error",
    });
    console.error("[candidatura.pre-check]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel realizar o pre-check agora. Tente novamente em alguns instantes.",
        meta: { correlationId },
      },
    };
  }
}

/**
 * Resolve auth de driver retornando UnauthorizedError/ForbiddenError ou a sessao.
 * Centraliza o tratamento de erros do `requireDriverSession` para reuso entre handlers.
 */
async function resolveDriverSessionOrError(request, correlationId) {
  try {
    const session = await requireDriverSession(getAuthorizationHeader(request));
    return { session };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return {
        errorResponse: {
          statusCode: 401,
          payload: {
            error: "Unauthorized",
            message: err.message,
            meta: { correlationId },
          },
        },
      };
    }
    if (err instanceof ForbiddenError) {
      return {
        errorResponse: {
          statusCode: 403,
          payload: {
            error: "Forbidden",
            message: err.message,
            meta: { correlationId },
          },
        },
      };
    }
    throw err;
  }
}

/**
 * POST /api/candidatura/draft
 * Upsert do draft do candidato (1 ativo por driver_user_id, TTL SLIDING 72h via updated_at).
 *
 * Body: { cargaId: string, dados: object }. Schema strict rejeita cpf/driver_user_id
 * (D-02 — vem da sessao, nunca do cliente).
 */
export async function resolveCandidaturaDraftSaveResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        meta: { correlationId },
      },
    };
  }

  // Bug-8 fix: endpoint passa a aceitar fluxo PUBLICO (sem driver session).
  // Tentamos resolver a session — se falhar com 401 (UnauthorizedError), seguimos
  // sem session e exigimos cpf no body. Demais erros (ex.: ForbiddenError pra
  // role errado) continuam bloqueando.
  let session = null;
  try {
    session = await requireDriverSession(getAuthorizationHeader(request));
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      const { errorResponse } = await resolveDriverSessionOrError(request, correlationId);
      if (errorResponse) return errorResponse;
    }
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  let parsedInput;
  try {
    parsedInput = candidaturaDraftSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }

  try {
    if (session?.user?.id) {
      return await saveCandidaturaDraft({
        driverUserId: session.user.id,
        cargaId: parsedInput.cargaId,
        dados: parsedInput.dados,
        requestIp,
        correlationId,
      });
    }

    // Fluxo PUBLICO — exige cpf no body pra identificar o draft.
    if (!parsedInput.cpf) {
      return {
        statusCode: 400,
        payload: {
          error: "BadRequest",
          message:
            "CPF e obrigatorio quando o rascunho e salvo sem login. Conclua o pre-check antes.",
          meta: { correlationId },
        },
      };
    }

    return await saveCandidaturaDraftByCpf({
      cpf: parsedInput.cpf,
      cargaId: parsedInput.cargaId,
      dados: parsedInput.dados,
      requestIp,
      correlationId,
    });
  } catch (err) {
    console.error("[candidatura.draft.save]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel salvar o rascunho agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}

/**
 * GET /api/candidatura/draft/me
 * Le o draft do driver autenticado (1 ativo).
 *
 * Retorna 204 se nao existe / esta expirado; 200 com { draft, expiresAt } caso contrario.
 */
export async function resolveCandidaturaDraftGetResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        meta: { correlationId },
      },
    };
  }

  // Fluxo PUBLICO (sem session Supabase) — espelha o save-draft-by-cpf:
  // aceita ?cpf=XXX na query e devolve o draft anonimo correspondente.
  // Mesma rate-limit geral (10/min/IP) que ja protege o POST.
  let session = null;
  try {
    session = await requireDriverSession(getAuthorizationHeader(request));
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      const { errorResponse } = await resolveDriverSessionOrError(request, correlationId);
      if (errorResponse) return errorResponse;
    }
  }

  // Iter #7 — cargaId opcional escopa o draft a uma carga especifica (multi-draft).
  const cargaIdRaw = getQueryParam(request, "cargaId");
  const cargaId = cargaIdRaw ? String(cargaIdRaw).trim() : null;

  try {
    if (session?.user?.id) {
      return await getCandidaturaDraft({
        driverUserId: session.user.id,
        cargaId: cargaId || undefined,
        correlationId,
      });
    }

    const rawCpf = getQueryParam(request, "cpf");
    const cpfDigits = String(rawCpf || "").replace(/\D/g, "");
    if (cpfDigits.length !== 11) {
      return { statusCode: 204 };
    }

    return await getCandidaturaDraftByCpf({ cpf: cpfDigits, correlationId });
  } catch (err) {
    console.error("[candidatura.draft.get]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel ler o rascunho agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}

/**
 * POST /api/candidatura/submit
 * Submit final do wizard de candidatura v2 (plan 07-04).
 *
 * Requer header `Idempotency-Key` (replay-safe — segundo POST com mesma key
 * retorna 200 com a row existente).
 *
 * Auth: driver session via Supabase Bearer (D-01).
 * Payload: validado por `candidaturaSubmitSchema` (W-05 strip `__` keys + W-09
 * telefone_primario espelho).
 */
export async function resolveCandidaturaSubmitResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        meta: { correlationId },
      },
    };
  }

  // Auth: opcional — fluxo publico (motoristas sem login) usa CPF do body.
  const { session } = await resolveDriverSessionOrError(request, correlationId);
  const driverUserId = session?.user?.id ?? null;

  // Idempotency-Key obrigatorio (T-07-15 — replay safety).
  const idempotencyKey =
    getHeaderValue(request, "Idempotency-Key")?.toString().trim() || "";
  if (!idempotencyKey) {
    return {
      statusCode: 400,
      payload: {
        error: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Header 'Idempotency-Key' obrigatorio para o submit.",
        meta: { correlationId },
      },
    };
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  // Bug 7 fix — Step A pode ter sido pulado no wizard (motorista ja cadastrado).
  // Nesse caso `body.dados.motorista` chega ausente/parcial e o schema rejeitaria.
  // Mesclamos o motorista persistido (use case get-existing-motorista) ANTES da
  // validacao zod. Frontend completo continua funcionando — apenas cobre o gap.
  if (body && typeof body === "object" && body.dados && typeof body.dados === "object") {
    const incomingMotorista = body.dados.motorista;
    if (isMotoristaPartial(incomingMotorista)) {
      // CPF para lookup no fluxo publico: tenta body.dados.motorista.cpf.
      let lookupCpf = (incomingMotorista?.cpf ?? "").toString().replace(/\D/g, "");
      // Se autenticado, prefere profile.document_number (D-02 source of truth).
      if (driverUserId) {
        try {
          const profileResp = await getDriverProfileByUserId({
            userId: driverUserId,
            correlationId,
          });
          const profileCpf = (profileResp?.payload?.profile?.document_number ?? "")
            .toString()
            .replace(/\D/g, "");
          if (profileCpf) lookupCpf = profileCpf;
        } catch {
          /* lookup CPF best-effort */
        }
      }

      try {
        const existing = await getExistingMotorista({
          driverUserId,
          driverCpf: lookupCpf || null,
        });
        if (existing) {
          body.dados.motorista = mergeMotorista(existing, incomingMotorista);
        }
      } catch (err) {
        // Falha de DB nao bloqueia — o zod abaixo vai reportar campos faltantes.
        console.warn("[candidatura.submit.merge-motorista]", {
          correlationId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Skip-Step-B fix — `dados.cavalo` incompleto (apenas { placa }) quando o
    // wizard pulou o Step B (placa do cavalo ja tem cadastro vigente). Faz
    // merge do veiculo persistido (+ cavalo_owner) ANTES da validacao zod.
    const incomingCavalo = body.dados.cavalo;
    if (isCavaloPartial(incomingCavalo)) {
      const placaForLookup = String(incomingCavalo?.placa ?? "").trim();
      let lookupCpf = (body.dados.motorista?.cpf ?? "").toString().replace(/\D/g, "");
      if (driverUserId) {
        try {
          const profileResp = await getDriverProfileByUserId({
            userId: driverUserId,
            correlationId,
          });
          const profileCpf = (profileResp?.payload?.profile?.document_number ?? "")
            .toString()
            .replace(/\D/g, "");
          if (profileCpf) lookupCpf = profileCpf;
        } catch {
          /* lookup CPF best-effort */
        }
      }
      if (placaForLookup) {
        try {
          const existing = await getExistingCavalo({
            driverUserId,
            driverCpf: lookupCpf || null,
            placa: placaForLookup,
          });
          if (existing?.cavalo) {
            body.dados.cavalo = mergeCavalo(existing.cavalo, incomingCavalo);
            // cavalo_owner ausente no payload + existente persistido → reidrata
            // (mesmo principio do cavalo: schema strict precisa do bloco).
            if (
              existing.cavalo_owner &&
              (!body.dados.cavalo_owner || typeof body.dados.cavalo_owner !== "object")
            ) {
              body.dados.cavalo_owner = existing.cavalo_owner;
            }
          }
        } catch (err) {
          console.warn("[candidatura.submit.merge-cavalo]", {
            correlationId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Fallback final — quando lookup nao achou cavalo prior e o motorista
      // ainda nao tem owner_doc no cavalo, assume que ele e o proprio dono
      // (consistente com `cavaloOwnerIsDriver` em submit-final). Operator
      // pode revisar no painel. Sem isso o schema strict rejeita.
      if (!body.dados.cavalo?.owner_doc && lookupCpf) {
        body.dados.cavalo = {
          ...(body.dados.cavalo || {}),
          owner_doc: lookupCpf,
          owner_doc_type: "cpf",
        };
      }
    }
  }

  let parsedInput;
  try {
    parsedInput = candidaturaSubmitSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      // Iter #7 — enriquece a resposta com mensagem agregada citando todas as
      // secoes/campos faltantes (em vez do generico do zodErrorToHttpResponse).
      const baseResponse = zodErrorToHttpResponse(err, correlationId);
      const friendlyMessage = buildMissingFieldsMessage(baseResponse.payload.issues || []);
      return {
        statusCode: baseResponse.statusCode,
        payload: {
          ...baseResponse.payload,
          message: friendlyMessage,
        },
      };
    }
    throw err;
  }

  // CPF: autenticado usa profile.document_number; publico usa dados.motorista.cpf.
  let driverCpf = "";
  if (session?.user?.id) {
    const profileResponse = await getDriverProfileByUserId({
      userId: session.user.id,
      correlationId,
    });
    driverCpf = profileResponse?.payload?.profile?.document_number ?? "";
  }
  if (!driverCpf) {
    driverCpf = (parsedInput.dados?.motorista?.cpf ?? "").replace(/\D/g, "");
  }

  // A1 fix — fluxo PUBLICO exige CPF identificavel (11 digitos). Evita
  // cadastros orfaos com driver_user_id=NULL e CPF vazio.
  if (!driverUserId) {
    const publicCpf = (driverCpf || "").replace(/\D/g, "");
    if (publicCpf.length !== 11) {
      return {
        statusCode: 400,
        payload: {
          error: "BadRequest",
          message:
            "CPF do motorista e obrigatorio no submit sem login. Conclua o pre-check antes.",
          meta: { correlationId },
        },
      };
    }
  }

  try {
    return await submitCandidaturaFinal({
      driverUserId,
      driverCpf,
      // Cadastro standalone omite cargaId → carga_id=NULL (sem carga associada).
      cargaId: parsedInput.cargaId ?? null,
      idempotencyKey,
      dados: parsedInput.dados,
      requestIp,
      correlationId,
      // A2 fix — no fluxo publico nao confiamos no CPF declarado pelo cliente
      // como source-of-truth para owner-reuse-by-driver. Sem login, o atacante
      // pode setar motorista.cpf == cavalo.owner_doc e pular cascata ANTT D-12.
      disableOwnerReuseByDriver: !driverUserId,
    });
  } catch (err) {
    console.error("[candidatura.submit]", {
      correlationId,
      code: err?.code,
      message: err instanceof Error ? err.message : String(err),
    });

    if (err?.code === "PROTOCOLO_SEQUENCE_UNAVAILABLE") {
      return {
        statusCode: 500,
        payload: {
          error: "ProtocoloSequenceUnavailable",
          message: err.message,
          meta: { correlationId },
        },
      };
    }

    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel concluir a candidatura agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}

/**
 * POST /api/candidatura/antt-precheck (W-03)
 *
 * Expoe a cascata ANTT inline para o Step C2 do wizard (plan 09).
 * NAO persiste nada — apenas consulta o sidecar e retorna { rntrc, tipo, situacao,
 * validade, requiresUpload, source }.
 */
export async function resolveCandidaturaAnttPrecheckResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        meta: { correlationId },
      },
    };
  }

  // Aceita sessão de motorista OU de operador (resgate de rascunho pelo painel).
  // Fluxo público (sem token) é rejeitado: a cascata consome quota Infosimples,
  // então exige requisição autenticada e atribuível.
  const { actor, errorResponse } = await resolveCandidaturaActor(
    getAuthorizationHeader(request),
    correlationId,
  );
  if (errorResponse) return errorResponse;
  if (actor.type === "public") {
    return {
      statusCode: 401,
      payload: {
        error: "Unauthorized",
        message: "Autenticação obrigatória para consultar a ANTT.",
        meta: { correlationId },
      },
    };
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  let parsedInput;
  try {
    parsedInput = candidaturaAnttPrecheckSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }

  try {
    const result = await resolveAnttCascade({
      docType: parsedInput.docType,
      doc: parsedInput.doc,
      placa: parsedInput.placa,
      correlationId,
    });

    return {
      statusCode: 200,
      payload: {
        rntrc: result.rntrc,
        tipo: result.tipo,
        situacao: result.situacao,
        validade: result.validade,
        titular_doc: result.titular_doc ?? null,
        titular_nome: result.titular_nome ?? null,
        source: result.source,
        requiresUpload: result.requiresUpload === true,
        meta: { correlationId },
      },
    };
  } catch (err) {
    console.error("[candidatura.antt-precheck]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel consultar a ANTT agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}

/**
 * POST /api/candidatura/verify-document (Phase 8, plan 08-20).
 *
 * Endpoint PUBLICO (sem driver-auth) para o wizard cadastro-v2 verificar se
 * um CPF/placa **diferente** do candidatado ja tem cadastro registrado.
 *
 * Caracteristicas:
 *   - Rate limit 5 req/min/IP via `verifyDocRateMap` (anti-enumeration).
 *   - Resposta sempre 200 (com `exists: bool`) — uniforme para reduzir
 *     enumeration de CPF/placa.
 *   - Apenas DB local (pending_driver_registrations + vehicles), sem chamada
 *     externa (Angellira/ASPX).
 *   - Audit log estruturado: correlationId, IP, type, value mascarado.
 *
 * Body: { type: 'cpf'|'horsePlate'|'trailerPlate', value: string }.
 * Response 200: { exists, status, lastCandidatura } — sem PII.
 * Response 422: validation error (zod).
 * Response 429: { error: 'rate_limited', retryAfterSeconds }.
 */
export async function resolveCandidaturaVerifyDocumentResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  // ── Rate limit dedicado (5/min/IP, anti-enumeration). ──────────────────
  const { limited, retryAfterSeconds } = checkVerifyDocRateLimit(requestIp);
  if (limited) {
    return {
      statusCode: 429,
      payload: {
        error: "rate_limited",
        message: "Muitas tentativas. Aguarde alguns segundos e tente novamente.",
        retryAfterSeconds,
        meta: { correlationId },
      },
    };
  }

  // ── Body parse ─────────────────────────────────────────────────────────
  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return {
      statusCode: 400,
      payload: {
        error: "invalid_payload",
        message: "Corpo da requisicao invalido (esperado JSON).",
        meta: { correlationId },
      },
    };
  }

  // ── Zod validation (sanitiza CPF/placa antes da query). ────────────────
  let parsedInput;
  try {
    parsedInput = candidaturaVerifyDocumentSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }

  // ── Audit log (PII mascarada). ─────────────────────────────────────────
  console.info("[candidatura.verify-document]", {
    correlationId,
    ip: requestIp || "unknown",
    type: parsedInput.type,
    valueMasked: maskVerifyDocumentValue(parsedInput.type, parsedInput.value),
  });

  // ── Use case ───────────────────────────────────────────────────────────
  try {
    const result = await verifyDocument({
      type: parsedInput.type,
      value: parsedInput.value,
      correlationId,
    });

    return {
      statusCode: 200,
      payload: {
        exists: result.exists,
        status: result.status,
        lastCandidatura: result.lastCandidatura,
        // 2026-05-18 — Estendido com AngelLira + ASPX (CPF/ownerCpf). Sem PII:
        // apenas `source` + `situacao` quando o doc existe externamente.
        externalRegistration: result.externalRegistration ?? null,
        meta: { correlationId },
      },
    };
  } catch (err) {
    console.error("[candidatura.verify-document]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    // Resposta uniforme tambem em erro interno — nao vaza dado real.
    return {
      statusCode: 200,
      payload: {
        exists: false,
        status: null,
        lastCandidatura: null,
        meta: { correlationId, degraded: true },
      },
    };
  }
}

/**
 * GET /api/driver/cadastros/incompletos (Iter #7)
 *
 * Lista drafts incompletos do motorista autenticado, com 1 entrada por carga.
 * DriverPortal usa para renderizar 1 notification card "Completar cadastro
 * pendente" por draft, com origem/destino/data da carga associada.
 *
 * Auth: driver session obrigatoria (D-01). Sem session retorna 401.
 *
 * Response 200: { drafts: [{ id, cargaId, currentStep, updatedAt, expiresAt,
 *   origem, destino, dataColeta, horarioColeta }] }
 */
export async function resolveListIncompleteCadastrosResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isRateLimited(requestIp)) {
    return {
      statusCode: 429,
      payload: {
        error: "TooManyRequests",
        message: "Muitas tentativas. Aguarde alguns instantes e tente novamente.",
        meta: { correlationId },
      },
    };
  }

  const { session, errorResponse } = await resolveDriverSessionOrError(request, correlationId);
  if (errorResponse) return errorResponse;
  if (!session?.user?.id) {
    return {
      statusCode: 401,
      payload: {
        error: "Unauthorized",
        message: "Login do motorista obrigatorio para listar cadastros incompletos.",
        meta: { correlationId },
      },
    };
  }

  try {
    return await listIncompleteCadastroDrafts({
      driverUserId: session.user.id,
      correlationId,
    });
  } catch (err) {
    console.error("[candidatura.list-incomplete-drafts]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel listar os cadastros incompletos agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}
