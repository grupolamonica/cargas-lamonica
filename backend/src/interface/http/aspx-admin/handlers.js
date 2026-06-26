import { requireOperatorSession } from "../../../application/load-claims/auth.js";
import { createCorrelationId } from "../../../application/load-claims/helpers.js";
import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import {
  getAspxSyncHealth,
  getAspxSyncStatus,
  refreshAspxSession,
  triggerAspxSync,
  updateAspxCookies,
} from "../../../application/aspx/aspx-admin.js";
import { buildHttpErrorResponse } from "../error-mapping.js";
import { getAuthorizationHeader, getHeaderValue, parseJsonBody } from "../http-utils.js";

function getCorrelationId(request) {
  return getHeaderValue(request, "X-Correlation-Id") || createCorrelationId();
}

function toErrorResponse(error, correlationId) {
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof ForbiddenError
      ? 403
      : typeof error?.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : error?.code === "GITHUB_TOKEN_MISSING"
      ? 503
      : 500;

  return buildHttpErrorResponse(
    status,
    {
      error: error?.name || "AspxAdminError",
      code: error?.code || "ASPX_ADMIN_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
    correlationId,
  );
}

export async function resolveAspxSyncStatusResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "operator:read",
      "Somente operadores autorizados podem consultar o status do ASPx.",
    );
    return await getAspxSyncStatus();
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveAspxSyncHealthResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "operator:read",
      "Somente operadores autorizados podem consultar a saude do sync ASPx.",
    );
    return await getAspxSyncHealth();
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveAspxSyncTriggerResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem sincronizar o ASPx.",
    );
    return await triggerAspxSync({ correlationId });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveAspxCookiesUpdateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem atualizar os cookies do SPX.",
    );
    const body = await parseJsonBody(request);
    // Aceita { cookies: <array|obj|string> } ou o próprio corpo como cookies.
    const cookiesJson =
      body && typeof body === "object" && "cookies" in body ? body.cookies : body;
    return await updateAspxCookies({ cookiesJson, correlationId });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveAspxSessionRefreshResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem renovar a sessao do SPX.",
    );
    return await refreshAspxSession({ correlationId });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}
