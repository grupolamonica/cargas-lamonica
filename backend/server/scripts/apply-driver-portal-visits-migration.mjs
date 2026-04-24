#!/usr/bin/env node
/**
 * Aplica a migration `driver_portal_visits` no Supabase apontado por SUPABASE_DB_URL.
 *
 * Segurança:
 *  - Transação única (BEGIN/COMMIT) com rollback automático em falha.
 *  - Idempotente: detecta estado já aplicado e sai sem mexer.
 *  - Dry-run por padrão. Use --apply para executar de fato.
 *
 * Uso:
 *   node backend/server/scripts/apply-driver-portal-visits-migration.mjs
 *   node backend/server/scripts/apply-driver-portal-visits-migration.mjs --apply
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import "../config/load-env.js";
import { buildPostgresSslConfig } from "../lib/postgres-ssl.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDirectory, "../../..");

const MIGRATION = {
  version: "20260418120000",
  name: "add_driver_portal_visits",
  filePath: path.join(
    projectRoot,
    "supabase/migrations/20260418120000_add_driver_portal_visits.sql",
  ),
};

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not configured in .env.");
  }

  return new Pool({
    connectionString,
    max: 1,
    ssl: buildPostgresSslConfig(),
  });
}

async function getState(client) {
  const { rows: versionRows } = await client.query(
    `
      SELECT 1
      FROM supabase_migrations.schema_migrations
      WHERE version = $1
    `,
    [MIGRATION.version],
  );

  const { rows: tableRows } = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'driver_portal_visits'
    `,
  );

  const { rows: indexRows } = await client.query(
    `
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'driver_portal_visits'
        AND indexname = 'idx_driver_portal_visits_at'
    `,
  );

  const { rows: rlsRows } = await client
    .query(
      `
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.driver_portal_visits'::regclass
      `,
    )
    .catch(() => ({ rows: [] }));

  return {
    migrationRecorded: versionRows.length > 0,
    tableExists: tableRows.length > 0,
    indexExists: indexRows.length > 0,
    rlsEnabled: rlsRows[0]?.relrowsecurity === true,
  };
}

async function applyMigrationInTransaction(client, sql) {
  await client.query("BEGIN");

  try {
    await client.query(sql);
    await client.query(
      `
        INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (version) DO NOTHING
      `,
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
    console.log(
      JSON.stringify(
        {
          step: "connect",
          mode: shouldApply ? "apply" : "dry-run",
          migrationVersion: MIGRATION.version,
          migrationName: MIGRATION.name,
        },
        null,
        2,
      ),
    );

    const before = await getState(client);
    console.log(JSON.stringify({ step: "state-before", ...before }, null, 2));

    const alreadyDone =
      before.migrationRecorded &&
      before.tableExists &&
      before.indexExists &&
      before.rlsEnabled;

    if (alreadyDone) {
      console.log(
        JSON.stringify(
          {
            step: "noop",
            result: "already-applied",
            message:
              "Migration já registrada e tabela/índice no shape esperado. Nada a fazer.",
          },
          null,
          2,
        ),
      );
      return;
    }

    if (!shouldApply) {
      console.log(
        JSON.stringify(
          {
            step: "dry-run",
            wouldApply: true,
            message:
              "Rode novamente com --apply para executar a migration em uma transação única.",
          },
          null,
          2,
        ),
      );
      return;
    }

    const sql = await fs.readFile(MIGRATION.filePath, "utf8");

    await applyMigrationInTransaction(client, sql);
    console.log(
      JSON.stringify(
        { step: "applied", version: MIGRATION.version, name: MIGRATION.name },
        null,
        2,
      ),
    );

    const after = await getState(client);
    console.log(JSON.stringify({ step: "state-after", ...after }, null, 2));

    const success =
      after.migrationRecorded &&
      after.tableExists &&
      after.indexExists &&
      after.rlsEnabled;

    if (!success) {
      throw new Error("Post-apply verification failed: " + JSON.stringify(after));
    }

    console.log(
      JSON.stringify(
        { step: "done", result: "success", verified: true },
        null,
        2,
      ),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        step: "error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
