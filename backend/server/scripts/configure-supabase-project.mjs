import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../config/load-env.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getProjectRef() {
  const directRef = process.env.VITE_SUPABASE_PROJECT_ID?.trim();
  if (directRef) {
    return directRef;
  }

  const projectUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  if (!projectUrl) {
    throw new Error("Missing VITE_SUPABASE_PROJECT_ID and SUPABASE_URL.");
  }

  const hostname = new URL(projectUrl).hostname;
  return hostname.split(".")[0];
}

async function supabaseManagementFetch(pathname, init = {}) {
  const projectAccessToken = getRequiredEnv("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(`https://api.supabase.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${projectAccessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Supabase management API error (${response.status}): ${payload}`);
  }

  const responseText = await response.text();
  return responseText ? JSON.parse(responseText) : null;
}

async function runDatabaseQuery(query, description) {
  const projectRef = getProjectRef();
  console.log(`[setup] Applying database step: ${description}`);

  return supabaseManagementFetch(`/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

async function patchAuthConfig() {
  const projectRef = getProjectRef();
  const siteUrl = process.env.SUPABASE_SITE_URL?.trim() || "http://127.0.0.1:8080";
  const uriAllowList =
    process.env.SUPABASE_URI_ALLOW_LIST?.trim() ||
    "http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:4173,http://localhost:4173";

  console.log("[setup] Updating auth configuration");

  return supabaseManagementFetch(`/v1/projects/${projectRef}/config/auth`, {
    method: "PATCH",
    body: JSON.stringify({
      disable_signup: false,
      external_anonymous_users_enabled: false,
      external_email_enabled: true,
      mailer_autoconfirm: false,
      mailer_allow_unverified_email_sign_ins: false,
      site_url: siteUrl,
      uri_allow_list: uriAllowList,
    }),
  });
}

async function verifyDatabaseSetup() {
  const verificationQuery = `
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'clientes'
      ) AS has_clientes,
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'cargas'
      ) AS has_cargas,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cargas' AND column_name = 'distancia_km'
      ) AS has_distancia_km,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cargas' AND column_name = 'duracao_horas'
      ) AS has_duracao_horas;
  `;

  console.log("[setup] Verifying database objects");
  const verificationResult = await runDatabaseQuery(verificationQuery, "verify schema");
  return Array.isArray(verificationResult) ? verificationResult[0] : verificationResult;
}

async function verifyAuthConfig() {
  const projectRef = getProjectRef();
  console.log("[setup] Verifying auth configuration");
  return supabaseManagementFetch(`/v1/projects/${projectRef}/config/auth`, {
    method: "GET",
  });
}

async function main() {
  const bootstrapSqlPath = path.join(projectRoot, "supabase", "bootstrap.sql");
  const bootstrapSql = await fs.readFile(bootstrapSqlPath, "utf8");

  await runDatabaseQuery(bootstrapSql, "bootstrap schema");
  const authConfig = await patchAuthConfig();
  const verification = await verifyDatabaseSetup();
  const authVerification = await verifyAuthConfig();

  console.log("[setup] Done");
  console.log(
    JSON.stringify(
      {
        projectRef: getProjectRef(),
        database: verification,
        auth: {
          site_url: authVerification?.site_url ?? authConfig?.site_url ?? null,
          uri_allow_list: authVerification?.uri_allow_list ?? authConfig?.uri_allow_list ?? null,
          disable_signup: authVerification?.disable_signup ?? authConfig?.disable_signup ?? null,
          mailer_autoconfirm:
            authVerification?.mailer_autoconfirm ?? authConfig?.mailer_autoconfirm ?? null,
          external_email_enabled:
            authVerification?.external_email_enabled ?? authConfig?.external_email_enabled ?? null,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[setup] Failed", error);
  process.exitCode = 1;
});
