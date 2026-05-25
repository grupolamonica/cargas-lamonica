#!/usr/bin/env node
/**
 * One-shot script para aplicar a migration 20260525120000_pending_driver_registrations_multi_draft_indexes.sql.
 *
 * Mirror de apply-cargas-casadas-migration.mjs.
 *
 * Usage:
 *   node backend/src/scripts/apply-pdr-multi-draft-indexes-migration.mjs           # dry-run
 *   node backend/src/scripts/apply-pdr-multi-draft-indexes-migration.mjs --apply   # execute
 *
 * Side effects when --apply is passed:
 *   - Cria 3 indices em public.pending_driver_registrations:
 *       idx_pdr_driver_carga_draft, idx_pdr_driver_drafts_with_carga,
 *       idx_pdr_duplicate_cpf_placa.
 *   - Insere row em supabase_migrations.schema_migrations.
 *
 * Safety: SQL e idempotente (CREATE INDEX IF NOT EXISTS) e roda em transacao.
 */

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

const MIGRATION = {
  version: "20260525120000",
  name: "pending_driver_registrations_multi_draft_indexes",
  filePath: path.join(
    projectRoot,
    "supabase/migrations/20260525120000_pending_driver_registrations_multi_draft_indexes.sql",
  ),
};

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) throw new Error("SUPABASE_DB_URL is not configured in .env.");
  return new Pool({ connectionString, max: 1, ssl: buildPostgresSslConfig() });
}

async function getState(client) {
  const { rows: versionRows } = await client.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1`,
    [MIGRATION.version],
  );
  const { rows: indexRows } = await client.query(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'pending_driver_registrations'
        AND indexname IN (
          'idx_pdr_driver_carga_draft',
          'idx_pdr_driver_drafts_with_carga',
          'idx_pdr_duplicate_cpf_placa'
        )`,
  );
  const indexes = new Set(indexRows.map((r) => r.indexname));
  return {
    migrationRecorded: versionRows.length > 0,
    hasDriverCargaDraft: indexes.has("idx_pdr_driver_carga_draft"),
    hasDriverDraftsWithCarga: indexes.has("idx_pdr_driver_drafts_with_carga"),
    hasDuplicateCpfPlaca: indexes.has("idx_pdr_duplicate_cpf_placa"),
  };
}

async function applyMigrationInTransaction(client, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
       VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
      [MIGRATION.version, [sql], MIGRATION.name],
    );
    await client.query("COMMIT");
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
    console.log(JSON.stringify({
      step: "connect",
      mode: shouldApply ? "apply" : "dry-run",
      migration: MIGRATION.version,
    }, null, 2));

    const before = await getState(client);
    console.log(JSON.stringify({ step: "state-before", ...before }, null, 2));

    const fullyApplied =
      before.migrationRecorded &&
      before.hasDriverCargaDraft &&
      before.hasDriverDraftsWithCarga &&
      before.hasDuplicateCpfPlaca;

    if (fullyApplied) {
      console.log(JSON.stringify({ step: "noop", result: "already-applied" }, null, 2));
      return;
    }

    if (!shouldApply) {
      console.log(JSON.stringify({
        step: "dry-run",
        wouldApply: true,
        message: "Re-run with --apply to execute.",
      }, null, 2));
      return;
    }

    const sql = await fs.readFile(MIGRATION.filePath, "utf8");
    await applyMigrationInTransaction(client, sql);

    const after = await getState(client);
    console.log(JSON.stringify({ step: "state-after", ...after }, null, 2));

    if (
      !after.migrationRecorded ||
      !after.hasDriverCargaDraft ||
      !after.hasDriverDraftsWithCarga ||
      !after.hasDuplicateCpfPlaca
    ) {
      throw new Error("Post-apply verification failed: " + JSON.stringify(after));
    }

    console.log(JSON.stringify({ step: "done", result: "success", verified: true }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

export default main;

main().catch((error) => {
  console.error(JSON.stringify({ step: "error", message: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
