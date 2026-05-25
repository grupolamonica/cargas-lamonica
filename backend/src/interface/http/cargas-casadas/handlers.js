/**
 * HTTP handlers para endpoints REST de cargas_casadas (pacote de cargas).
 *
 * Pattern espelhado de operator-admin/handlers.js:
 *  - withOperatorSession: valida JWT + permissao + idempotency cache (5min, MAX 5k)
 *  - assertOperatorPermission por handler
 *  - Idempotency-Key header em mutacoes (T-10-09)
 *  - X-Correlation-Id propagado (audit + erros)
 *  - Erros mapeados via zodErrorToHttpResponse / buildServiceErrorResponse / buildInternalErrorResponse
 */

import "../../../infrastructure/config/load-env.js";

import { ZodError } from "zod";

import { recordSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import {
  getAuthorizationHeader,
  getCorrelationId,
  getHeaderValue,
  getQueryParam,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import {
  addCargaSchema,
  listPacotesQuerySchema,
  pacoteCreateSchema,
  pacoteIdParamsSchema,
  pacoteUpdateSchema,
  removeCargaParamsSchema,
  reorderCargasSchema,
} from "../../../domain/cargas-casadas/schemas.js";
import { buildInternalErrorResponse, buildServiceErrorResponse } from "../error-mapping.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";
import {
  ForbiddenError,
  LoadClaimServiceError,
  UnauthorizedError,
} from "../../../domain/load-claims/errors.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { requireOperatorSession } from "../../../application/load-claims/auth.js";
import {
  addCargaToPacote,
  cancelPacote,
  createPacote,
  getPacote,
  listPacotes,
  publishPacote,
  removeCargaFromPacote,
  reorderCargasInPacote,
  updatePacote,
} from "../../../application/cargas-casadas/service.js";

const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const MAX_IDEMPOTENCY_CACHE_SIZE = 5_000;
const idempotencyCache = new Map();

function checkIdempotencyCache(key) {
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    idempotencyCache.delete(key);
    return null;
  }
  return entry.response;
}

function setIdempotencyCache(key, response) {
  if (idempotencyCache.size >= MAX_IDEMPOTENCY_CACHE_SIZE) {
    // MD-01: varre expirados antes de delete arbitrario (FIFO != LRU)
    const now = Date.now();
    let deleted = false;
    for (const [k, v] of idempotencyCache) {
      if (v.expiresAt <= now) {
        idempotencyCache.delete(k);
        deleted = true;
        break;
      }
    }
    if (!deleted) {
      idempotencyCache.delete(idempotencyCache.keys().next().value);
    }
  }
  idempotencyCache.set(key, { response, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}

function toErrorResponse(error, correlationId) {
  if (error instanceof ZodError) {
    return zodErrorToHttpResponse(error, correlationId);
  }
  if (error instanceof LoadClaimServiceError) {
    return buildServiceErrorResponse(error, correlationId, { includeDetails: true });
  }
  return buildInternalErrorResponse(
    correlationId,
    "Unexpected error while processing the pacote request.",
  );
}

async function withOperatorSession(request, action, optionsOrExecute, maybeExecute) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);
  const options = typeof optionsOrExecute === "function" ? {} : optionsOrExecute;
  const execute = typeof optionsOrExecute === "function" ? optionsOrExecute : maybeExecute;
  let user = null;
  let accessLevel = null;
  const rawIdempotencyKey = getHeaderValue(request, "Idempotency-Key");

  try {
    const session = await requireOperatorSession(getAuthorizationHeader(request));
    user = session.user;
    accessLevel = session.accessLevel;

    if (options.requiredPermission) {
      assertOperatorPermission(user, options.requiredPermission, options.forbiddenMessage);
    }

    if (rawIdempotencyKey) {
      const cacheKey = `${user.id}:${action}:${rawIdempotencyKey}`;
      const cachedResponse = checkIdempotencyCache(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      const response = await execute({
        correlationId,
        requestIp,
        operatorId: user.id,
        operatorAccessLevel: accessLevel,
        user,
      });
      setIdempotencyCache(cacheKey, response);
      return response;
    }

    return await execute({
      correlationId,
      requestIp,
      operatorId: user.id,
      operatorAccessLevel: accessLevel,
      user,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      await recordSecurityAuditEvent({
        eventType: "operator.pacote.request.denied",
        severity: "warn",
        actorUserId: user?.id ?? null,
        actorRole: user ? `operator:${accessLevel || "unknown"}` : "unknown",
        resourceType: "cargas-casadas",
        action,
        outcome: "denied",
        requestIp,
        correlationId,
        metadata: {
          path: request.url || null,
          method: request.method || "GET",
          reason: error.code,
          requiredPermission: options.requiredPermission || null,
          operatorAccessLevel: accessLevel,
        },
      });
    } else {
      logStructuredEvent("error", "operator.pacote.request.failed", {
        action,
        correlationId,
        requestIp,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return toErrorResponse(error, correlationId);
  }
}

const WRITE_PERMISSION = "cargos:write";
const READ_PERMISSION = "operator:read";
const FORBIDDEN_WRITE_MESSAGE =
  "Somente operadores com acesso intermediario ou avancado podem alterar pacotes.";
const FORBIDDEN_READ_MESSAGE = "Sem permissao para visualizar pacotes.";

export async function resolveCreatePacoteResponse(request) {
  return withOperatorSession(
    request,
    "create-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const rawBody = await parseJsonBody(request);
      const payload = pacoteCreateSchema.parse(rawBody ?? {});

      return createPacote({ operatorId, payload, requestIp, correlationId });
    },
  );
}

export async function resolveUpdatePacoteResponse(request) {
  return withOperatorSession(
    request,
    "update-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      const payload = pacoteUpdateSchema.parse(await parseJsonBody(request));

      return updatePacote({ operatorId, pacoteId, payload, requestIp, correlationId });
    },
  );
}

export async function resolveAddCargaPacoteResponse(request) {
  return withOperatorSession(
    request,
    "add-carga-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      const body = addCargaSchema.parse(await parseJsonBody(request));

      return addCargaToPacote({
        operatorId,
        pacoteId,
        cargaId: body.cargaId,
        ordem: body.ordem,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolveRemoveCargaPacoteResponse(request) {
  return withOperatorSession(
    request,
    "remove-carga-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId, cargaId } = removeCargaParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
        cargaId: getQueryParam(request, "cargaId"),
      });

      return removeCargaFromPacote({
        operatorId,
        pacoteId,
        cargaId,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolveReorderCargasPacoteResponse(request) {
  return withOperatorSession(
    request,
    "reorder-cargas-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      const body = reorderCargasSchema.parse(await parseJsonBody(request));

      return reorderCargasInPacote({
        operatorId,
        pacoteId,
        orderings: body.orderings,
        requestIp,
        correlationId,
      });
    },
  );
}

export async function resolvePublishPacoteResponse(request) {
  return withOperatorSession(
    request,
    "publish-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      return publishPacote({ operatorId, pacoteId, requestIp, correlationId });
    },
  );
}

export async function resolveCancelPacoteResponse(request) {
  return withOperatorSession(
    request,
    "cancel-pacote",
    { requiredPermission: WRITE_PERMISSION, forbiddenMessage: FORBIDDEN_WRITE_MESSAGE },
    async ({ correlationId, requestIp, operatorId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      return cancelPacote({ operatorId, pacoteId, requestIp, correlationId });
    },
  );
}

export async function resolveListPacotesResponse(request) {
  return withOperatorSession(
    request,
    "list-pacotes",
    { requiredPermission: READ_PERMISSION, forbiddenMessage: FORBIDDEN_READ_MESSAGE },
    async ({ correlationId }) => {
      const raw = request.query || {};
      const parsed = listPacotesQuerySchema.parse({
        status: typeof raw.status === "string" && raw.status.trim() !== "" ? raw.status : undefined,
        limit: raw.limit,
        offset: raw.offset,
      });
      return listPacotes({
        status: parsed.status,
        limit: parsed.limit,
        offset: parsed.offset,
        correlationId,
      });
    },
  );
}

export async function resolveGetPacoteResponse(request) {
  return withOperatorSession(
    request,
    "get-pacote",
    { requiredPermission: READ_PERMISSION, forbiddenMessage: FORBIDDEN_READ_MESSAGE },
    async ({ correlationId }) => {
      const { pacoteId } = pacoteIdParamsSchema.parse({
        pacoteId: getQueryParam(request, "pacoteId"),
      });
      return getPacote({ pacoteId, correlationId });
    },
  );
}
