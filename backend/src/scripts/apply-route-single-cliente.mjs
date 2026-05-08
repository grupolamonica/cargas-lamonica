#!/usr/bin/env node
/**
 * Aplica a migration route_single_cliente (20260508000002).
 * Modelo: 1:N cliente -> rotas (substitui o N:M antigo).
 *
 * Uso:
 *   node --env-file=.env.dev src/scripts/apply-route-single-cliente.mjs           # dry-run
 *   node --env-file=.env.dev src/scripts/apply-route-single-cliente.mjs --apply   # executa
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dir, "../../..");

const MIGRATION_VERSION = "20260508000002";
const MIGRATION_NAME    = "route_single_cliente";
const MIGRATION_FILE    = path.join(
  PROJECT_ROOT,
  "backend/supabase/migrations/20260508000002_route_single_cliente.sql",
);

function buildDirectUrl(poolerUrl) {
  return poolerUrl.replace("?pgbouncer=true", "").replace(":6543/postgres", ":5432/postgres");
}

function createPool() {
  const rawUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!rawUrl) throw new Error("SUPABASE_DB_URL não configurado.");
  const connectionString = buildDirectUrl(rawUrl);
  console.log(JSON.stringify({ step: "connect", host: new URL(connectionString).host }));
  return new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
}

async function checkState(client) {
  const out = {};
  // rotas.cliente_id existe?
  const colCheck = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'rotas' AND column_name = 'cliente_id'`,
  );
  out.rotas_cliente_id_exists = colCheck.rowCount > 0;

  // cliente_rotas ainda existe?
  const tableCheck = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'cliente_rotas'`,
  );
  out.cliente_rotas_table_exists = tableCheck.rowCount > 0;

  // Quantas rotas com cliente
  try {
    const r = await client.query(`SELECT COUNT(*)::int AS n FROM public.rotas WHERE cliente_id IS NOT NULL`);
    out.rotas_com_cliente = r.rows[0]?.n ?? 0;
  } catch {
    out.rotas_com_cliente = "N/A";
  }

  // Pré-requisito: 20260508000001 aplicada (rotas table existe)
  const preReq = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'rotas'`,
  );
  out.prereq_rotas_table_exists = preReq.rowCount > 0;

  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pool = createPool();
  const client = await pool.connect();
  try {
    console.log(JSON.stringify({ step: "mode", apply }));

    const before = await checkState(client);
    console.log(JSON.stringify({ step: "state-before", ...before }, null, 2));

    if (!before.prereq_rotas_table_exists) {
      throw new Error("Pré-requisito faltando: tabela rotas não existe. Aplicar 20260508000001 primeiro.");
    }

    const alreadyApplied = before.rotas_cliente_id_exists && !before.cliente_rotas_table_exists;
    if (alreadyApplied) {
      console.log(JSON.stringify({ step: "noop", message: "Migration já aplicada." }));
      return;
    }

    if (!apply) {
      console.log(JSON.stringify({
        step: "dry-run",
        message: "Use --apply para executar.",
        willAdd: ["rotas.cliente_id (UUID FK clientes)"],
        willDrop: ["cliente_rotas table"],
        willRecreate: ["v_clientes_com_rotas view"],
      }, null, 2));
      return;
    }

    const sql = await fs.readFile(MIGRATION_FILE, "utf8");
    const sqlBody = sql.replace(/^\s*BEGIN\s*;\s*/im, "").replace(/\s*COMMIT\s*;\s*$/im, "");

    await client.query("BEGIN");
    try {
      await client.query(sqlBody);
      await client.query("COMMIT");
      console.log(JSON.stringify({ step: "applied", version: MIGRATION_VERSION }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    try {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
         VALUES ($1, ARRAY[$2], $3) ON CONFLICT (version) DO NOTHING`,
        [MIGRATION_VERSION, sql, MIGRATION_NAME],
      );
      console.log(JSON.stringify({ step: "registry", recorded: true }));
    } catch {
      console.log(JSON.stringify({ step: "registry", recorded: false }));
    }

    const after = await checkState(client);
    console.log(JSON.stringify({ step: "state-after", ...after }, null, 2));

    const success = after.rotas_cliente_id_exists && !after.cliente_rotas_table_exists;
    if (!success) throw new Error("Verificação pós-apply falhou: " + JSON.stringify(after));
    console.log(JSON.stringify({ step: "done", result: "success" }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ step: "error", message: err.message }));
  process.exit(1);
});
