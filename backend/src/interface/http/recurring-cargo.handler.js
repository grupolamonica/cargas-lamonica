import crypto from "node:crypto";

import "../../infrastructure/config/load-env.js";

import { advanceRecurringCargas } from "../../application/operator-admin/use-cases/advance-recurring-cargas.js";

function getErrorPayload(error) {
  return {
    error: error?.name || "InternalServerError",
    code: error?.code || "INTERNAL_SERVER_ERROR",
    message: "Unexpected error while advancing recurring cargas.",
  };
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Comparação dummy para evitar timing leak no length check
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(request) {
  const cronSecret = process.env.CRON_SECRET?.trim();

  // Fail closed: sem CRON_SECRET configurado, negar sempre
  if (!cronSecret) {
    return false;
  }

  const authorization =
    typeof request.headers?.get === "function"
      ? request.headers.get("authorization") || ""
      : request.headers?.authorization || request.headers?.Authorization || "";

  return timingSafeStringEqual(authorization, `Bearer ${cronSecret}`);
}

/**
 * Endpoint de fallback para cron externo avançar cargas recorrentes quando o
 * job inline está desligado (RECURRING_CARGO_ADVANCE_INLINE=false). Mesma
 * autenticação do sheet-sync (CRON_SECRET).
 */
export async function resolveAdvanceRecurringCargasResponse(request) {
  if (!isAuthorized(request)) {
    return {
      statusCode: 401,
      payload: {
        error: "Unauthorized",
        code: "UNAUTHORIZED",
        message: "Use the configured CRON_SECRET authorization header.",
      },
    };
  }

  try {
    const result = await advanceRecurringCargas();
    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...result,
      },
    };
  } catch (error) {
    console.error("[recurring-cargo-advance-api]", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });

    return {
      statusCode: 500,
      payload: getErrorPayload(error),
    };
  }
}
