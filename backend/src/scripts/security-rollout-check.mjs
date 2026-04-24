import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import "../infrastructure/config/load-env.js";
import { buildPostgresSslConfig } from "../infrastructure/pg/postgres-ssl.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDirectory, "../../..");

const SECURITY_MIGRATIONS = [
  {
    version: "20260408093000",
    name: "harden_current_app_role",
    filePath: path.join(projectRoot, "supabase/migrations/20260408093000_harden_current_app_role.sql"),
  },
  {
    version: "20260408120000",
    name: "add_security_audit_and_public_lead_redaction",
    filePath: path.join(projectRoot, "supabase/migrations/20260408120000_add_security_audit_and_public_lead_redaction.sql"),
  },
  {
    version: "20260413113000",
    name: "add_load_public_leads_to_realtime",
    filePath: path.join(projectRoot, "supabase/migrations/20260413113000_add_load_public_leads_to_realtime.sql"),
  },
  {
    version: "20260414150000",
    name: "add_public_lead_validation_snapshot",
    filePath: path.join(projectRoot, "supabase/migrations/20260414150000_add_public_lead_validation_snapshot.sql"),
  },
];

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not configured.");
  }

  return new Pool({
    connectionString,
    max: 1,
    ssl: buildPostgresSslConfig(),
  });
}

async function getMigrationVersions(client) {
  const { rows } = await client.query(`
    SELECT version
    FROM supabase_migrations.schema_migrations
    ORDER BY version ASC
  `);

  return rows.map((row) => row.version);
}

async function getCurrentAppRoleDefinition(client) {
  const { rows } = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'current_app_role'
  `);

  return rows[0]?.definition || null;
}

async function getCriticalColumns(client) {
  const { rows } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'load_public_leads' AND column_name IN ('pii_redacted_at', 'cpf', 'phone', 'horse_plate', 'trailer_plate')) OR
        (table_name = 'load_public_leads' AND column_name IN ('validation_status', 'validation_checked_at', 'validation_summary_json')) OR
        (table_name = 'security_audit_logs' AND column_name IN ('event_type', 'severity', 'actor_user_id', 'correlation_id', 'metadata'))
      )
    ORDER BY table_name, column_name
  `);

  return rows;
}

async function getCriticalIndexes(client) {
  const { rows } = await client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_load_public_leads_pii_redacted_at',
        'idx_load_public_leads_validation_status',
        'idx_security_audit_logs_event_created_at',
        'idx_security_audit_logs_actor_created_at'
      )
    ORDER BY indexname
  `);

  return rows.map((row) => row.indexname);
}

async function getRealtimeTables(client) {
  const { rows } = await client.query(`
    SELECT tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename IN ('cargas', 'load_claims', 'load_claim_events', 'load_public_leads')
    ORDER BY tablename
  `);

  return rows.map((row) => row.tablename);
}

async function getPolicies(client) {
  const { rows } = await client.query(`
    SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'security_audit_logs',
        'load_public_leads',
        'cargas',
        'clientes',
        'route_metrics_cache'
      )
    ORDER BY tablename, policyname
  `);

  return rows;
}

async function getSchemaState(client) {
  return {
    appliedVersions: await getMigrationVersions(client),
    currentAppRoleDefinition: await getCurrentAppRoleDefinition(client),
    criticalColumns: await getCriticalColumns(client),
    criticalIndexes: await getCriticalIndexes(client),
    realtimeTables: await getRealtimeTables(client),
    policies: await getPolicies(client),
  };
}

function summarizeValidation(state) {
  const appliedVersionSet = new Set(state.appliedVersions);
  const criticalColumnSet = new Set(state.criticalColumns.map((row) => `${row.table_name}.${row.column_name}`));
  const policySet = new Set(state.policies.map((row) => `${row.tablename}.${row.policyname}`));
  const functionDefinition = state.currentAppRoleDefinition || "";

  return {
    migrationsApplied: SECURITY_MIGRATIONS.every((migration) => appliedVersionSet.has(migration.version)),
    currentAppRoleHardened:
      functionDefinition.includes("app_metadata") &&
      functionDefinition.includes("user_metadata") &&
      !functionDefinition.includes("COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', 'operator')"),
    piiRedactionColumnPresent: criticalColumnSet.has("load_public_leads.pii_redacted_at"),
    securityAuditTablePresent: criticalColumnSet.has("security_audit_logs.event_type"),
    auditIndexesPresent:
      state.criticalIndexes.includes("idx_security_audit_logs_event_created_at") &&
      state.criticalIndexes.includes("idx_security_audit_logs_actor_created_at"),
    leadRedactionIndexPresent: state.criticalIndexes.includes("idx_load_public_leads_pii_redacted_at"),
    leadValidationColumnsPresent:
      criticalColumnSet.has("load_public_leads.validation_status") &&
      criticalColumnSet.has("load_public_leads.validation_checked_at") &&
      criticalColumnSet.has("load_public_leads.validation_summary_json"),
    leadValidationIndexPresent: state.criticalIndexes.includes("idx_load_public_leads_validation_status"),
    publicLeadRealtimeEnabled: state.realtimeTables.includes("load_public_leads"),
    auditPolicyPresent: policySet.has("security_audit_logs.Operators can view security audit logs"),
    publicLeadPoliciesPresent:
      policySet.has("load_public_leads.Operators can view public load leads") &&
      policySet.has("load_public_leads.Operators can update public load leads"),
  };
}

async function applyMigration(client, migration) {
  const sql = await fs.readFile(migration.filePath, "utf8");

  await client.query("BEGIN");

  try {
    await client.query(sql);
    await client.query(
      `
        INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (version) DO NOTHING
      `,
      [migration.version, [sql], migration.name],
    );
    await client.query("COMMIT");
    return {
      version: migration.version,
      name: migration.name,
      status: "applied",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const shouldApply = process.argv.includes("--apply");
  const pool = createPool();
  const client = await pool.connect();

  try {
    const before = await getSchemaState(client);
    const appliedVersionSet = new Set(before.appliedVersions);
    const pending = SECURITY_MIGRATIONS.filter((migration) => !appliedVersionSet.has(migration.version));
    const appliedNow = [];

    if (shouldApply) {
      for (const migration of pending) {
        appliedNow.push(await applyMigration(client, migration));
      }
    }

    const after = await getSchemaState(client);
    const validation = summarizeValidation(after);

    console.log(
      JSON.stringify(
        {
          mode: shouldApply ? "apply" : "check",
          pendingBeforeApply: pending.map((migration) => migration.version),
          appliedNow,
          validation,
          before: {
            appliedVersions: before.appliedVersions,
            currentAppRoleDefinition: before.currentAppRoleDefinition,
            criticalColumns: before.criticalColumns,
            criticalIndexes: before.criticalIndexes,
            realtimeTables: before.realtimeTables,
            policyCount: before.policies.length,
          },
          after: {
            appliedVersions: after.appliedVersions,
            currentAppRoleDefinition: after.currentAppRoleDefinition,
            criticalColumns: after.criticalColumns,
            criticalIndexes: after.criticalIndexes,
            realtimeTables: after.realtimeTables,
            policyCount: after.policies.length,
          },
        },
        null,
        2,
      ),
    );

    if (shouldApply && Object.values(validation).some((value) => value !== true)) {
      process.exitCode = 2;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
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
