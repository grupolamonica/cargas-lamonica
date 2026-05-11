#!/usr/bin/env node
/**
 * One-shot script to apply the pending_driver_registrations migration.
 *
 * Usage:
 *   node backend/src/scripts/apply-pending-driver-registrations-migration.mjs
 *   node backend/src/scripts/apply-pending-driver-registrations-migration.mjs --apply
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
  version: "20260506000003",
  name: "pending_driver_registrations",
  filePath: path.join(
    projectRoot,
    "supabase/migrations/20260506000003_pending_driver_registrations.sql",
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
  const { rows: tableRows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pending_driver_registrations'`,
  );
  return {
    migrationRecorded: versionRows.length > 0,
    tableExists: tableRows.length > 0,
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
    console.log(JSON.stringify({ step: "connect", mode: shouldApply ? "apply" : "dry-run", migration: MIGRATION.version }, null, 2));

    const before = await getState(client);
    console.log(JSON.stringify({ step: "state-before", ...before }, null, 2));

    if (before.migrationRecorded && before.tableExists) {
      console.log(JSON.stringify({ step: "noop", result: "already-applied" }, null, 2));
      return;
    }

    if (!shouldApply) {
      console.log(JSON.stringify({ step: "dry-run", wouldApply: true, message: "Re-run with --apply to execute." }, null, 2));
      return;
    }

    const sql = await fs.readFile(MIGRATION.filePath, "utf8");
    await applyMigrationInTransaction(client, sql);

    const after = await getState(client);
    console.log(JSON.stringify({ step: "state-after", ...after }, null, 2));

    if (!after.migrationRecorded || !after.tableExists) {
      throw new Error("Post-apply verification failed: " + JSON.stringify(after));
    }

    console.log(JSON.stringify({ step: "done", result: "success", verified: true }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ step: "error", message: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
