import fs from "node:fs";
import path from "node:path";

const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no"]);

function normalizeBooleanEnv(value, defaultValue) {
  const normalizedValue = value?.trim().toLowerCase();

  if (!normalizedValue) {
    return defaultValue;
  }

  return !DISABLED_ENV_VALUES.has(normalizedValue);
}

function normalizePemCertificate(value) {
  return value.replace(/\\n/g, "\n").trim();
}

function resolveCaPath(rawPath) {
  if (!rawPath) {
    return null;
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function readConfiguredCaCertificate() {
  const configuredSources = [
    process.env.CLAIMS_DB_SSL_CA_PATH?.trim() ? "path" : null,
    process.env.CLAIMS_DB_SSL_CA_B64?.trim() ? "b64" : null,
    process.env.CLAIMS_DB_SSL_CA_CERT?.trim() ? "cert" : null,
  ].filter(Boolean);

  if (configuredSources.length > 1) {
    throw new Error(
      "Configure only one of CLAIMS_DB_SSL_CA_PATH, CLAIMS_DB_SSL_CA_B64 or CLAIMS_DB_SSL_CA_CERT.",
    );
  }

  const caPath = resolveCaPath(process.env.CLAIMS_DB_SSL_CA_PATH?.trim());

  if (caPath) {
    if (!fs.existsSync(caPath)) {
      throw new Error(`Configured Postgres CA file was not found: ${caPath}`);
    }

    return {
      ca: fs.readFileSync(caPath, "utf8"),
      source: "path",
      detail: caPath,
    };
  }

  const caB64 = process.env.CLAIMS_DB_SSL_CA_B64?.trim();

  if (caB64) {
    try {
      return {
        ca: Buffer.from(caB64, "base64").toString("utf8"),
        source: "b64",
        detail: "CLAIMS_DB_SSL_CA_B64",
      };
    } catch (error) {
      throw new Error(
        `Configured Postgres CA base64 value is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const caCert = process.env.CLAIMS_DB_SSL_CA_CERT?.trim();

  if (caCert) {
    return {
      ca: normalizePemCertificate(caCert),
      source: "cert",
      detail: "CLAIMS_DB_SSL_CA_CERT",
    };
  }

  return {
    ca: null,
    source: null,
    detail: null,
  };
}

export function isEnabledEnv(name, defaultValue = true) {
  return normalizeBooleanEnv(process.env[name], defaultValue);
}

export function shouldRejectUnauthorizedSsl() {
  return isEnabledEnv("CLAIMS_DB_SSL_REJECT_UNAUTHORIZED", true);
}

export function getPostgresTlsConfiguration() {
  const rejectUnauthorized = shouldRejectUnauthorizedSsl();
  const { ca, source, detail } = readConfiguredCaCertificate();

  return {
    rejectUnauthorized,
    ca,
    caConfigured: Boolean(ca),
    caSource: source,
    caDetail: detail,
  };
}

export function buildPostgresSslConfig() {
  const tlsConfiguration = getPostgresTlsConfiguration();

  return tlsConfiguration.caConfigured
    ? {
        rejectUnauthorized: tlsConfiguration.rejectUnauthorized,
        ca: tlsConfiguration.ca,
      }
    : {
        rejectUnauthorized: tlsConfiguration.rejectUnauthorized,
      };
}

export function isSelfSignedChainError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return combinedMessage.includes("self-signed certificate");
}
