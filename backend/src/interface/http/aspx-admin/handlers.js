import { requireOperatorSession } from "../../../application/load-claims/auth.js";
import { createCorrelationId } from "../../../application/load-claims/helpers.js";
import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { getAspxSyncStatus, triggerAspxSync } from "../../../application/aspx/aspx-admin.js";
import { getAuthorizationHeader, getHeaderValue } from "../http-utils.js";

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

  return {
    statusCode: status,
    payload: {
      error: error?.name || "AspxAdminError",
      code: error?.code || "ASPX_ADMIN_ERROR",
      message: error instanceof Error ? error.message : String(error),
      meta: { correlationId },
    },
  };
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
