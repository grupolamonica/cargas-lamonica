import { Pool } from "pg";

import "../infrastructure/config/load-env.js";
import {
  getPostgresTlsConfiguration,
  isEnabledEnv,
  isSelfSignedChainError,
} from "../infrastructure/pg/postgres-ssl.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

function buildPool(tlsConfiguration) {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    return null;
  }

  return new Pool({
    connectionString,
    max: 1,
    ssl: tlsConfiguration.caConfigured
      ? {
          rejectUnauthorized: tlsConfiguration.rejectUnauthorized,
          ca: tlsConfiguration.ca,
        }
      : {
          rejectUnauthorized: tlsConfiguration.rejectUnauthorized,
        },
  });
}

async function getDatabaseChecks(pool) {
  if (!pool) {
    return {
      databaseReachable: false,
      currentAppRoleHardened: false,
      securityAuditTablePresent: false,
      publicLeadRedactionColumnPresent: false,
      migrationVersions: [],
      error: "SUPABASE_DB_URL ausente",
    };
  }

  let client;

  try {
    client = await pool.connect();
    const { rows: migrationRows } = await client.query(`
      SELECT version
      FROM supabase_migrations.schema_migrations
      WHERE version IN ('20260408093000', '20260408120000', '20260414150000')
      ORDER BY version ASC
    `);
    const { rows: functionRows } = await client.query(`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'current_app_role'
    `);
    const { rows: columnRows } = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'security_audit_logs' AND column_name = 'event_type') OR
          (table_name = 'load_public_leads' AND column_name IN ('pii_redacted_at', 'validation_status', 'validation_checked_at', 'validation_summary_json'))
        )
    `);

    const columnSet = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
    const currentAppRoleDefinition = functionRows[0]?.definition || "";

    return {
      databaseReachable: true,
      currentAppRoleHardened:
        currentAppRoleDefinition.includes("app_metadata") &&
        currentAppRoleDefinition.includes("user_metadata") &&
        !currentAppRoleDefinition.includes("COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', 'operator')"),
      securityAuditTablePresent: columnSet.has("security_audit_logs.event_type"),
      publicLeadRedactionColumnPresent: columnSet.has("load_public_leads.pii_redacted_at"),
      publicLeadValidationColumnsPresent:
        columnSet.has("load_public_leads.validation_status") &&
        columnSet.has("load_public_leads.validation_checked_at") &&
        columnSet.has("load_public_leads.validation_summary_json"),
      migrationVersions: migrationRows.map((row) => row.version),
      error: null,
    };
  } catch (error) {
    return {
      databaseReachable: false,
      currentAppRoleHardened: false,
      securityAuditTablePresent: false,
      publicLeadRedactionColumnPresent: false,
      publicLeadValidationColumnsPresent: false,
      migrationVersions: [],
      error: error?.message || String(error),
    };
  } finally {
    client?.release();
  }
}

async function main() {
  let tlsConfiguration;
  let tlsConfigurationError = null;

  try {
    tlsConfiguration = getPostgresTlsConfiguration();
  } catch (error) {
    tlsConfigurationError = error instanceof Error ? error.message : String(error);
    tlsConfiguration = {
      rejectUnauthorized: isEnabledEnv("CLAIMS_DB_SSL_REJECT_UNAUTHORIZED", true),
      ca: null,
      caConfigured: false,
      caSource: null,
      caDetail: null,
    };
  }

  const pool = tlsConfigurationError ? null : buildPool(tlsConfiguration);

  try {
    const databaseChecks = await getDatabaseChecks(pool);
    const blockers = [];
    const warnings = [];

    if (!hasEnv("VITE_SUPABASE_URL")) {
      blockers.push("VITE_SUPABASE_URL ausente");
    }

    if (!hasEnv("VITE_SUPABASE_PUBLISHABLE_KEY")) {
      blockers.push("VITE_SUPABASE_PUBLISHABLE_KEY ausente");
    }

    if (!hasEnv("SUPABASE_DB_URL")) {
      blockers.push("SUPABASE_DB_URL ausente");
    }

    if (!hasEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      blockers.push("SUPABASE_SERVICE_ROLE_KEY ausente");
    }

    if (!hasEnv("PUBLIC_LOAD_WHATSAPP_NUMBER")) {
      blockers.push("PUBLIC_LOAD_WHATSAPP_NUMBER ausente");
    }

    if (!isEnabledEnv("CLAIMS_DB_SSL_REJECT_UNAUTHORIZED", true)) {
      blockers.push("CLAIMS_DB_SSL_REJECT_UNAUTHORIZED=false reduz a validacao de TLS");
    }

    if (tlsConfigurationError) {
      blockers.push(`Configuracao TLS do banco invalida: ${tlsConfigurationError}`);
    }

    if (!databaseChecks.databaseReachable) {
      blockers.push(`Banco nao validado nesta checagem: ${databaseChecks.error}`);

      if (isSelfSignedChainError(databaseChecks.error) && tlsConfiguration.rejectUnauthorized) {
        if (!tlsConfiguration.caConfigured) {
          blockers.push(
            "Banco exige cadeia TLS confiavel; configure CLAIMS_DB_SSL_CA_PATH, CLAIMS_DB_SSL_CA_B64 ou CLAIMS_DB_SSL_CA_CERT.",
          );
        } else {
          blockers.push(
            `Banco apresentou cadeia TLS nao confiavel mesmo com CA configurada via ${tlsConfiguration.caSource}. Verifique a cadeia ou atualize a CA local.`,
          );
        }
      }
    }

    if (databaseChecks.databaseReachable && !databaseChecks.currentAppRoleHardened) {
      blockers.push("current_app_role ainda nao esta endurecida no banco");
    }

    if (databaseChecks.databaseReachable && !databaseChecks.securityAuditTablePresent) {
      blockers.push("security_audit_logs nao existe no banco");
    }

    if (databaseChecks.databaseReachable && !databaseChecks.publicLeadRedactionColumnPresent) {
      blockers.push("load_public_leads.pii_redacted_at nao existe no banco");
    }

    if (databaseChecks.databaseReachable && !databaseChecks.publicLeadValidationColumnsPresent) {
      blockers.push("load_public_leads ainda nao possui o snapshot de validacao de leads");
    }

    if (!isEnabledEnv("RUN_SUPABASE_RLS_TESTS", false)) {
      warnings.push("RUN_SUPABASE_RLS_TESTS=false; a auditoria real de RLS pode ser pulada fora do pipeline");
    }

    if (process.env.DEV_SERVER_HOST?.trim() && process.env.DEV_SERVER_HOST.trim() !== "127.0.0.1") {
      warnings.push("DEV_SERVER_HOST nao esta preso em 127.0.0.1");
    }

    if (isEnabledEnv("TRUST_PROXY_HEADERS", true) && !hasEnv("TRUSTED_CLIENT_IP_HEADER")) {
      warnings.push("TRUST_PROXY_HEADERS=true sem TRUSTED_CLIENT_IP_HEADER explicito");
    }

    console.log(
      JSON.stringify(
        {
          ok: blockers.length === 0,
          blockers,
          warnings,
          checks: {
            viteSupabaseUrlConfigured: hasEnv("VITE_SUPABASE_URL"),
            viteSupabasePublishableKeyConfigured: hasEnv("VITE_SUPABASE_PUBLISHABLE_KEY"),
            supabaseDbUrlConfigured: hasEnv("SUPABASE_DB_URL"),
            supabaseServiceRoleConfigured: hasEnv("SUPABASE_SERVICE_ROLE_KEY"),
            publicLeadWhatsappConfigured: hasEnv("PUBLIC_LOAD_WHATSAPP_NUMBER"),
            strictDatabaseTls: tlsConfiguration.rejectUnauthorized,
            databaseTlsCaConfigured: tlsConfiguration.caConfigured,
            databaseTlsCaSource: tlsConfiguration.caSource,
            databaseTlsCaDetail: tlsConfiguration.caDetail,
            trustedProxyHeaders: isEnabledEnv("TRUST_PROXY_HEADERS", true),
            trustedClientIpHeaderConfigured: hasEnv("TRUSTED_CLIENT_IP_HEADER"),
            runSupabaseRlsTests: isEnabledEnv("RUN_SUPABASE_RLS_TESTS", false),
            database: databaseChecks,
          },
        },
        null,
        2,
      ),
    );

    if (blockers.length) {
      process.exitCode = 2;
    }
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          name: error?.name || "Error",
          code: error?.code || null,
          message: error?.message || String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
