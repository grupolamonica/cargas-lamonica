#!/usr/bin/env node
/**
 * apply-migrations-lbpzkdec.mjs
 *
 * Aplica todas migrations SQL de supabase/migrations/ em ordem cronologica
 * no projeto lbpzkdecwraipbjbaajs (Supabase). Mantem registro em
 * supabase_migrations.schema_migrations (mesmo schema usado pelo supabase CLI)
 * para idempotencia: migration ja aplicada e pulada.
 *
 * Uso:
 *   SUPABASE_DB_URL="postgresql://..." node src/scripts/apply-migrations-lbpzkdec.mjs
 *
 * Comportamento:
 *   1. Conecta ao DB.
 *   2. Cria schema supabase_migrations + tabela schema_migrations se nao existir.
 *   3. Lista arquivos .sql ordenados por nome (timestamp prefix garante ordem).
 *   4. Para cada arquivo: se version (timestamp) ja registrada -> SKIP; senao -> aplica
 *      em transacao + INSERT em schema_migrations. Failure aborta.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

function timestampFromFilename(name) {
  // 20260225144047_xxx.sql -> 20260225144047
  const m = name.match(/^(\d+)_/);
  return m ? m[1] : null;
}

async function main() {
  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) {
    console.error("ERROR: SUPABASE_DB_URL env var nao definida");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log(`[connect] ${conn.split("@")[1] ?? "(host hidden)"}`);

  // Bootstrap migrations tracking table (mesmo schema que supabase CLI usa).
  await client.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
  `);

  // List local migration files.
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`[plan] ${files.length} arquivos .sql em ordem cronologica`);

  // Get already-applied versions.
  const { rows: applied } = await client.query(
    `SELECT version FROM supabase_migrations.schema_migrations`,
  );
  const appliedSet = new Set(applied.map((r) => r.version));
  console.log(`[state] ${appliedSet.size} migrations ja aplicadas no DB`);

  let appliedCount = 0;
  let skippedCount = 0;
  let failedFile = null;

  for (const file of files) {
    const version = timestampFromFilename(file);
    if (!version) {
      console.warn(`[skip] ${file} (sem timestamp prefix)`);
      continue;
    }

    if (appliedSet.has(version)) {
      skippedCount += 1;
      // Silent skip — muito verboso senao.
      continue;
    }

    const fullPath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(fullPath, "utf8");

    console.log(`[apply] ${file} (${sql.length} bytes)`);

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
         VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING`,
        [version, file.replace(/\.sql$/, ""), [sql]],
      );
      await client.query("COMMIT");
      appliedCount += 1;
      console.log(`[ok]    ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[FAIL] ${file}\n${err.message}`);
      failedFile = file;
      break;
    }
  }

  await client.end();

  console.log("\n────────── RESUMO ──────────");
  console.log(`Aplicadas agora:  ${appliedCount}`);
  console.log(`Ja existiam:      ${skippedCount}`);
  console.log(`Total no DB:      ${appliedSet.size + appliedCount}`);
  if (failedFile) {
    console.log(`\n[ERROR] Parou em: ${failedFile}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
