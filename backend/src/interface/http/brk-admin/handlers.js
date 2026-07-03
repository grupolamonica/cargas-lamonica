import { requireOperatorSession } from "../../../application/load-claims/auth.js";
import { createCorrelationId } from "../../../application/load-claims/helpers.js";
import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { getBrkSyncStatus, updateBrkCookies } from "../../../application/brk/brk-admin.js";
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
      : 500;

  return buildHttpErrorResponse(
    status,
    {
      error: error?.name || "BrkAdminError",
      code: error?.code || "BRK_ADMIN_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
    correlationId,
  );
}

export async function resolveBrkSyncStatusResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "operator:read",
      "Somente operadores autorizados podem consultar o status do BRK.",
    );
    return await getBrkSyncStatus();
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveBrkCookiesUpdateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem atualizar os cookies do BRK.",
    );
    const body = await parseJsonBody(request);
    // Aceita { cookies: <array|obj|string>, userAgent } ou o próprio corpo como cookies.
    const cookiesJson =
      body && typeof body === "object" && "cookies" in body ? body.cookies : body;
    const userAgent =
      body && typeof body === "object" ? body.userAgent || body.user_agent : undefined;
    return await updateBrkCookies({ cookiesJson, userAgent, correlationId });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}
