#!/usr/bin/env node
/**
 * Aplica a migration schema_audit_route_remodel no banco apontado por SUPABASE_DB_URL.
 *
 * Uso:
 *   node --env-file=.env.dev src/scripts/apply-schema-audit-route-remodel.mjs           # dry-run
 *   node --env-file=.env.dev src/scripts/apply-schema-audit-route-remodel.mjs --apply   # executa
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dir, "../../..");

const MIGRATION_VERSION = "20260508000001";
const MIGRATION_NAME    = "schema_audit_route_remodel";
const MIGRATION_FILE    = path.join(
  PROJECT_ROOT,
  "backend/supabase/migrations/20260508000001_schema_audit_route_remodel.sql",
);

function buildDirectUrl(poolerUrl) {
  // Usa session pooler (porta 5432) que suporta transações DDL.
  // poolerUrl: postgresql://postgres.<ref>:<pass>@aws-*.pooler.supabase.com:6543/postgres?pgbouncer=true
  return poolerUrl
    .replace("?pgbouncer=true", "")
    .replace(":6543/postgres", ":5432/postgres");
}

function createPool() {
  const rawUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!rawUrl) throw new Error("SUPABASE_DB_URL não configurado.");

  const connectionString = buildDirectUrl(rawUrl);
  console.log(JSON.stringify({ step: "connect", host: new URL(connectionString).host }));

  return new Pool({
    connectionString,
    max: 1,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

async function checkState(client) {
  const tables = ["rotas", "rota_tarifas", "cliente_rotas"];
  const results = {};

  for (const t of tables) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [t],
    );
    results[`table_${t}`] = rows.length > 0;
  }

  // Verifica colunas dropadas de clientes
  const deadCols = ["peso", "rastreamento", "antt", "valor_frete", "tipo_veiculo"];
  for (const col of deadCols) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = $1`,
      [col],
    );
    results[`clientes.${col}_still_exists`] = rows.length > 0;
  }

  // rota_id em cargas
  const { rows: rotaIdRows } = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cargas' AND column_name = 'rota_id'`,
  );
  results["cargas.rota_id_exists"] = rotaIdRows.length > 0;

  // Contagem de rotas migradas de route_metrics_cache
  const { rows: rotasCount } = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.rotas`,
  ).catch(() => ({ rows: [{ n: "N/A (table not yet created)" }] }));
  results["rotas_count"] = rotasCount[0]?.n;

  // Contagem de tarifas migradas
  const { rows: tarifasCount } = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.rota_tarifas`,
  ).catch(() => ({ rows: [{ n: "N/A" }] }));
  results["rota_tarifas_count"] = tarifasCount[0]?.n;

  // Contagem de linhas em route_metrics_cache
  const { rows: cacheCount } = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.route_metrics_cache`,
  ).catch(() => ({ rows: [{ n: "N/A" }] }));
  results["route_metrics_cache_count"] = cacheCount[0]?.n;

  return results;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pool  = createPool();
  const client = await pool.connect();

  try {
    // Disable statement timeout for the session — DDL can take longer than default
    await client.query("SET statement_timeout = 0");

    console.log(JSON.stringify({ step: "mode", apply }));

    const before = await checkState(client);
    console.log(JSON.stringify({ step: "state-before", ...before }, null, 2));

    const alreadyApplied =
      before["table_rotas"] &&
      before["table_rota_tarifas"] &&
      before["table_cliente_rotas"] &&
      !before["clientes.peso_still_exists"];

    if (alreadyApplied) {
      console.log(JSON.stringify({ step: "noop", message: "Migration já aplicada." }));
      return;
    }

    if (!apply) {
      console.log(JSON.stringify({
        step: "dry-run",
        message: "Use --apply para executar a migration.",
        willCreate: ["rotas", "rota_tarifas", "cliente_rotas"],
        willDrop:   ["clientes.peso", "clientes.rastreamento", "clientes.antt",
                     "clientes.valor_frete", "clientes.tipo_veiculo"],
        willAdd:    ["cargas.rota_id"],
      }, null, 2));
      return;
    }

    const sql = await fs.readFile(MIGRATION_FILE, "utf8");

    // Remove BEGIN/COMMIT do arquivo — usa transação programática
    const sqlBody = sql
      .replace(/^\s*BEGIN\s*;\s*/im, "")
      .replace(/\s*COMMIT\s*;\s*$/im, "");

    await client.query("BEGIN");
    try {
      await client.query(sqlBody);
      await client.query("COMMIT");
      console.log(JSON.stringify({ step: "applied", version: MIGRATION_VERSION }));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    // Registro opcional na tabela de migrations (pode não existir em todos os envs)
    try {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, statements, name)
         VALUES ($1, ARRAY[$2], $3)
         ON CONFLICT (version) DO NOTHING`,
        [MIGRATION_VERSION, sql, MIGRATION_NAME],
      );
      console.log(JSON.stringify({ step: "registry", recorded: true }));
    } catch {
      console.log(JSON.stringify({ step: "registry", recorded: false, reason: "schema_migrations not available" }));
    }

    const after = await checkState(client);
    console.log(JSON.stringify({ step: "state-after", ...after }, null, 2));

    const success =
      after["table_rotas"] &&
      after["table_rota_tarifas"] &&
      after["table_cliente_rotas"] &&
      !after["clientes.peso_still_exists"] &&
      !after["clientes.tipo_veiculo_still_exists"] &&
      after["cargas.rota_id_exists"];

    if (!success) throw new Error("Verificação pós-apply falhou: " + JSON.stringify(after));

    console.log(JSON.stringify({ step: "done", result: "success", verified: true }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ step: "error", message: err.message, stack: err.stack }));
  process.exit(1);
});
