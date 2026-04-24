#!/usr/bin/env node
/**
 * Revalida TODOS os motoristas da tabela motoristas_historico consultando o
 * ASPx (planilha Google) em paralelo e atualizando aspx_found/aspx_display_name/aspx_matched_at.
 *
 * Uso:
 *   node backend/server/scripts/revalidate-all-drivers-aspx.mjs
 *   node backend/server/scripts/revalidate-all-drivers-aspx.mjs --concurrency=20
 *   node backend/server/scripts/revalidate-all-drivers-aspx.mjs --limit=500
 */
import "../infrastructure/config/load-env.js";
import { withPgClient } from "../infrastructure/pg/postgres.js";
import { lookupAspxDriverByCpf } from "../infrastructure/aspx/aspx-directory.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) return true;
  }
  return fallback;
}

const CONCURRENCY = Math.max(1, Number(parseArg("concurrency", 20)));
const LIMIT = parseArg("limit", null);

async function fetchAllDrivers(client) {
  const limitClause = LIMIT ? `LIMIT ${Number.parseInt(LIMIT, 10)}` : "";
  const { rows } = await client.query(`
    SELECT cpf
    FROM public.motoristas_historico
    WHERE cpf IS NOT NULL AND cpf <> ''
    ORDER BY aspx_matched_at ASC NULLS FIRST, nome ASC
    ${limitClause}
  `);
  return rows;
}

async function syncAspxResult(client, cpf, result) {
  await client.query(
    `
      UPDATE public.motoristas_historico
      SET
        aspx_found = $2,
        aspx_display_name = $3,
        aspx_matched_at = now()
      WHERE cpf = $1
    `,
    [cpf, Boolean(result?.found), result?.displayName || null],
  );
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main() {
  const correlationId = `aspx-all-${Date.now()}`;
  const startedAt = Date.now();

  const drivers = await withPgClient(fetchAllDrivers);
  console.log(`[aspx-revalidate] ${drivers.length} CPFs encontrados.`);
  if (drivers.length === 0) {
    process.exit(0);
  }

  let foundCount = 0;
  let notFoundCount = 0;
  let failed = 0;
  let processed = 0;

  for (const batch of chunk(drivers, CONCURRENCY)) {
    await withPgClient(async (client) => {
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          const lookup = await lookupAspxDriverByCpf(row.cpf, { correlationId });
          if (lookup.availability === "UNAVAILABLE") {
            return { cpf: row.cpf, skipped: true };
          }
          await syncAspxResult(client, row.cpf, lookup);
          return { cpf: row.cpf, found: lookup.found };
        }),
      );
      for (const r of results) {
        processed += 1;
        if (r.status === "fulfilled") {
          if (r.value?.found) foundCount += 1;
          else if (!r.value?.skipped) notFoundCount += 1;
        } else {
          failed += 1;
        }
      }
    });
    if (processed % 200 === 0 || processed === drivers.length) {
      const pct = Math.round((processed / drivers.length) * 100);
      console.log(`[aspx-revalidate] [${pct}%] processed=${processed}/${drivers.length} found=${foundCount} notFound=${notFoundCount} failed=${failed} elapsed=${formatDuration(Date.now() - startedAt)}`);
    }
  }

  const totalElapsed = Date.now() - startedAt;
  console.log("\n==== RESUMO ASPx ====");
  console.log(`Total de CPFs:         ${drivers.length}`);
  console.log(`Encontrados ASPx:      ${foundCount}`);
  console.log(`Nao encontrados:       ${notFoundCount}`);
  console.log(`Falhas:                ${failed}`);
  console.log(`Concorrencia:          ${CONCURRENCY}`);
  console.log(`Tempo total:           ${formatDuration(totalElapsed)}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
