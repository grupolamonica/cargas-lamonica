#!/usr/bin/env node
// One-shot apply for 20260508000001_schema_audit_route_remodel.sql
// Skips heavy checkState — just applies SQL in a transaction.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.resolve(__dir, "../../supabase/migrations/20260508000001_schema_audit_route_remodel.sql");

const rawUrl = process.env.SUPABASE_DB_URL?.trim();
if (!rawUrl) throw new Error("SUPABASE_DB_URL não configurado.");

const connectionString = rawUrl
  .replace("?pgbouncer=true", "")
  .replace(":6543/postgres", ":5432/postgres");

console.log(JSON.stringify({ step: "connect", host: new URL(connectionString).host }));

const pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const client = await pool.connect();

try {
  await client.query("SET statement_timeout = 0");
  console.log(JSON.stringify({ step: "timeout_disabled" }));

  const sql = await fs.readFile(SQL_FILE, "utf8");
  const sqlBody = sql
    .replace(/^\s*BEGIN\s*;\s*/im, "")
    .replace(/\s*COMMIT\s*;\s*$/im, "");

  await client.query("BEGIN");
  try {
    await client.query(sqlBody);
    await client.query("COMMIT");
    console.log(JSON.stringify({ step: "applied", migration: "20260508000001" }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // Quick verify
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('rotas','rota_tarifas','cliente_rotas') ORDER BY table_name`
  );
  const { rows: deadCols } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clientes' AND column_name IN ('peso','tipo_veiculo')`
  );
  const { rows: rotaId } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cargas' AND column_name='rota_id'`
  );

  console.log(JSON.stringify({
    step: "verify",
    tables_created: tables.map(r => r.table_name),
    dead_cols_remain: deadCols.map(r => r.column_name),
    cargas_rota_id: rotaId.length > 0,
    success: tables.length === 3 && deadCols.length === 0 && rotaId.length > 0,
  }));
} finally {
  client.release();
  await pool.end();
}
