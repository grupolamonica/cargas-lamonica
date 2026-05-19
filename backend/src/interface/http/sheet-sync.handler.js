import crypto from "node:crypto";

import "../../infrastructure/config/load-env.js";
import { logger } from "../../infrastructure/logger.js";

import { createSupabaseAdminClient, syncGoogleSheetLoads } from "../../application/google-sheets/google-sheet-loads.js";

function getErrorPayload(error) {
  return {
    error: error?.name || "InternalServerError",
    code: error?.code || "INTERNAL_SERVER_ERROR",
    message: "Unexpected error while syncing Google Sheet loads.",
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

export async function resolveSheetSyncResponse(request) {
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
    const supabaseClient = createSupabaseAdminClient();
    const result = await syncGoogleSheetLoads({
      supabaseClient,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...result,
      },
    };
  } catch (error) {
    logger.error({ err: error }, "sheet-sync-api error");

    return {
      statusCode: 500,
      payload: getErrorPayload(error),
    };
  }
}
