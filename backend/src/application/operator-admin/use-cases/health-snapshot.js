import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getPostgresTlsConfiguration, isEnabledEnv } from "../../../infrastructure/pg/postgres-ssl.js";
import { getDriverValidationMetricsSnapshot } from "../../../infrastructure/metrics.js";

async function probeAngelliraConnectivity() {
  const configured = Boolean(
    process.env.ANGELLIRA_USER?.trim() &&
    process.env.ANGELLIRA_PASSWORD?.trim() &&
    process.env.ANGELLIRA_EMPRESA_ID?.trim(),
  );
  if (!configured) return "not_configured";

  try {
    const { lookupAngelliraDriverByCpf } = await import("../../driver-validation/angellira-client.js");
    const result = await lookupAngelliraDriverByCpf("00000000000");
    return result.availability === "UNAVAILABLE" ? `error:${result.errorCode || "UNAVAILABLE"}` : "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function probeGeoapifyConnectivity() {
  try {
    const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
    if (!apiKey) return "not_configured";
    const { getGeoapifyJson } = await import("../../geoapify/geoapify-client.js");
    await getGeoapifyJson("/v1/geocode/search", { text: "Sao Paulo", format: "json", limit: 1 }, { timeoutMs: 4_000 });
    return "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function probeGoogleSheetsConnectivity() {
  try {
    const { getSheetExportUrl, fetchGoogleSheetCsv } = await import("../../google-sheet-loads.js");
    const sheetUrl = getSheetExportUrl();
    if (!sheetUrl) return "not_configured";
    await fetchGoogleSheetCsv(globalThis.fetch, sheetUrl);
    return "ok";
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getHealthSnapshot({ correlationId, deep = false }) {
  const tlsConfiguration = getPostgresTlsConfiguration();
  const trustedProxyHeaders = isEnabledEnv("TRUST_PROXY_HEADERS", true);
  const driverValidationMetrics = getDriverValidationMetricsSnapshot();

  return withPgClient(async (client) => {
    await client.query("SELECT 1");

    const deepChecks = deep
      ? await Promise.allSettled([
          probeAngelliraConnectivity(),
          probeGeoapifyConnectivity(),
          probeGoogleSheetsConnectivity(),
        ]).then(([angellira, geoapify, sheets]) => ({
          angellira: angellira.status === "fulfilled" ? angellira.value : `error:${angellira.reason}`,
          geoapify: geoapify.status === "fulfilled" ? geoapify.value : `error:${geoapify.reason}`,
          googleSheets: sheets.status === "fulfilled" ? sheets.value : `error:${sheets.reason}`,
        }))
      : null;

    return {
      statusCode: 200,
      payload: {
        ok: true,
        service: "lamonica-cargas-platform",
        checks: {
          database: "ok",
          publicLeadWhatsappConfigured: Boolean(process.env.PUBLIC_LOAD_WHATSAPP_NUMBER?.trim()),
          claimCronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
          strictDatabaseTls: tlsConfiguration.rejectUnauthorized,
          databaseTlsCaConfigured: tlsConfiguration.caConfigured,
          databaseTlsCaSource: tlsConfiguration.caSource,
          trustedProxyHeaders,
          canonicalClientIpHeaderConfigured: Boolean(process.env.TRUSTED_CLIENT_IP_HEADER?.trim()),
          ...(deepChecks ? { integrations: deepChecks } : {}),
        },
        features: { driverValidation: driverValidationMetrics },
        meta: { correlationId, timestamp: new Date().toISOString(), deepCheck: deep },
      },
    };
  });
}
