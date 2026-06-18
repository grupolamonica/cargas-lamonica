import crypto from "node:crypto";

import "../../infrastructure/config/load-env.js";

import { syncGoogleSheetLoads } from "../../application/google-sheets/google-sheet-loads.js";
import { syncDriverVinculos } from "../../application/google-sheets/driver-vinculos.js";
import { createSupabaseAdminClient } from "../../infrastructure/supabase/admin-client.js";

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

    // Sync da aba "Vinculo" — não-fatal: não derruba o sync de cargas.
    let vinculos = null;
    try {
      vinculos = await syncDriverVinculos({ supabaseClient });
    } catch (vinculoError) {
      console.error("[sheet-sync-api] erro no sync de vinculos:", vinculoError?.message);
      vinculos = { error: vinculoError?.message ?? "unknown" };
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...result,
        vinculos,
      },
    };
  } catch (error) {
    console.error("[sheet-sync-api]", {
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
