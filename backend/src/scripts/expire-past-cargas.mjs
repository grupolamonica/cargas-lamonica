#!/usr/bin/env node
/**
 * expire-past-cargas.mjs — Iter #8 (2026-05-25)
 *
 * Transita OPEN -> EXPIRED em cargas cuja `(data + horario)` ja passou.
 *
 * Motorista nao deve ver cargas expiradas na fila (filtro em runtime ja faz
 * isso via WHERE em buildDriverLoadFilters). Mas o painel do operator continua
 * mostrando como OPEN ate este script rodar — o que polui as listas "ativas"
 * e os dashboards. Rodar este script periodicamente (cron a cada 15 min) limpa
 * o estado.
 *
 * Uso:
 *   node src/scripts/expire-past-cargas.mjs [--dry-run] [--limit N]
 *
 * Flags:
 *   --dry-run  Lista o que seria atualizado, sem fazer UPDATE.
 *   --limit N  Maximo de rows pra processar (default: nenhum).
 *
 * Env vars (consumidas por load-env.js):
 *   SUPABASE_DB_URL  Connection string Postgres.
 */

import "../infrastructure/config/load-env.js";
import { Pool } from "pg";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitFlagIdx = args.indexOf("--limit");
const limit =
  limitFlagIdx >= 0 && args[limitFlagIdx + 1]
    ? Number.parseInt(args[limitFlagIdx + 1], 10)
    : null;

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "[expire-past-cargas] ERROR: SUPABASE_DB_URL (or DATABASE_URL) not set in env.",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function main() {
  console.log(
    `[expire-past-cargas] dryRun=${dryRun} limit=${limit ?? "all"} ts=${new Date().toISOString()}`,
  );

  // Cargas com (data + horario) ja passado, ainda em OPEN, nao template, nao
  // reservadas no sheet (preservamos visibilidade pra cargas alocadas em
  // pipeline ativo, mesmo que horario tenha estourado — operador resolve).
  const selectSql = `
    SELECT id, data, horario, origem, destino, status, sheet_motorista
    FROM public.cargas
    WHERE status = 'OPEN'
      AND data IS NOT NULL
      AND (data < CURRENT_DATE
        OR (data = CURRENT_DATE AND horario IS NOT NULL AND horario < CURRENT_TIME))
      AND COALESCE(is_template, false) = false
      AND COALESCE(sheet_motorista, '') = ''
    ORDER BY data, horario
    ${limit ? `LIMIT ${limit}` : ""}
  `;

  const { rows: candidates } = await pool.query(selectSql);
  console.log(
    `[expire-past-cargas] found ${candidates.length} expired OPEN cargas.`,
  );

  if (candidates.length === 0) {
    await pool.end();
    return;
  }

  // Print sample (first 10)
  for (const c of candidates.slice(0, 10)) {
    console.log(
      `  [${c.id.slice(0, 8)}] ${c.data} ${c.horario ?? "??"} | ${c.origem} -> ${c.destino}`,
    );
  }
  if (candidates.length > 10) {
    console.log(`  ... and ${candidates.length - 10} more`);
  }

  if (dryRun) {
    console.log("[expire-past-cargas] --dry-run; no UPDATE performed.");
    await pool.end();
    return;
  }

  // Transition OPEN -> EXPIRED em batch.
  const ids = candidates.map((c) => c.id);
  const updateSql = `
    UPDATE public.cargas
    SET status = 'EXPIRED', updated_at = now()
    WHERE id = ANY($1::uuid[])
      AND status = 'OPEN'
    RETURNING id
  `;
  const { rowCount } = await pool.query(updateSql, [ids]);
  console.log(
    `[expire-past-cargas] transitioned ${rowCount} cargas OPEN -> EXPIRED.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error("[expire-past-cargas] FATAL:", err);
  process.exit(1);
});
