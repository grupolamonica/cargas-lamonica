#!/usr/bin/env node
/**
 * Revalida TODOS os veículos da tabela public.vehicles consultando o Angellira
 * em paralelo (concorrência configurável) e persistindo o resultado via
 * syncVehicleAngelliraLookup. Uso:
 *
 *   node backend/server/scripts/revalidate-all-vehicles.mjs               # prod run
 *   node backend/server/scripts/revalidate-all-vehicles.mjs --concurrency=5
 *   node backend/server/scripts/revalidate-all-vehicles.mjs --limit=100   # testa em subset
 *   node backend/server/scripts/revalidate-all-vehicles.mjs --dry-run     # não grava no banco
 */
import "../config/load-env.js";
import { withPgClient } from "../lib/postgres.js";
import { lookupAngelliraPlate } from "../services/driver-validation/angellira-client.js";
import { syncVehicleAngelliraLookup } from "../services/operator-admin/service.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === `--${name}`) {
      return true;
    }
  }
  return fallback;
}

const CONCURRENCY = Math.max(1, Number(parseArg("concurrency", 10)));
const LIMIT = parseArg("limit", null);
const DRY_RUN = Boolean(parseArg("dry-run", false));
const PROGRESS_EVERY = 25;

async function fetchAllVehicles(client) {
  const limitClause = LIMIT ? `LIMIT ${Number.parseInt(LIMIT, 10)}` : "";
  const { rows } = await client.query(`
    SELECT plate, plate_role, vehicle_type, linked_driver_cpf, angellira_checked_at
    FROM public.vehicles
    ORDER BY angellira_checked_at ASC NULLS FIRST, updated_at ASC NULLS FIRST
    ${limitClause}
  `);
  return rows;
}

async function processBatch(batch, correlationId) {
  return Promise.allSettled(
    batch.map(async (row) => {
      const lookup = await lookupAngelliraPlate(row.plate, { correlationId });
      if (lookup.availability !== "OK") {
        return { plate: row.plate, skipped: true, reason: lookup.availability };
      }
      if (!DRY_RUN) {
        await syncVehicleAngelliraLookup({
          plate: row.plate,
          plateRole: row.plate_role,
          vehicleType: row.vehicle_type,
          angelliraResult: lookup,
          linkedDriverCpf: row.linked_driver_cpf,
          correlationId,
        });
      }
      return {
        plate: row.plate,
        updated: true,
        status: lookup.status,
        found: lookup.found,
        validUntil: lookup.validUntil || null,
      };
    }),
  );
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem > 0 ? ` ${rem}s` : ""}`;
}

async function main() {
  const correlationId = `revalidate-all-${Date.now()}`;
  const startedAt = Date.now();

  const vehicles = await withPgClient(fetchAllVehicles);
  console.log(`[revalidate-all-vehicles] Encontrados ${vehicles.length} veículos.`);
  if (DRY_RUN) console.log("[revalidate-all-vehicles] DRY_RUN: não persistirá no banco.");
  if (vehicles.length === 0) {
    console.log("Nada a fazer.");
    process.exit(0);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  const batches = chunk(vehicles, CONCURRENCY);
  for (const [index, batch] of batches.entries()) {
    const batchResults = await processBatch(batch, correlationId);
    for (const result of batchResults) {
      processed += 1;
      if (result.status === "fulfilled") {
        if (result.value?.updated) updated += 1;
        else if (result.value?.skipped) skipped += 1;
      } else {
        failed += 1;
        console.error(`  x ${batch[batchResults.indexOf(result)].plate}: ${result.reason?.message || result.reason}`);
      }
    }
    if ((index + 1) % Math.max(1, Math.round(PROGRESS_EVERY / CONCURRENCY)) === 0 || index === batches.length - 1) {
      const elapsed = Date.now() - startedAt;
      const pct = Math.round((processed / vehicles.length) * 100);
      const rate = processed > 0 ? (processed / (elapsed / 1000)).toFixed(1) : "0.0";
      console.log(
        `  [${pct}%] processed=${processed}/${vehicles.length} updated=${updated} skipped=${skipped} failed=${failed} elapsed=${formatDuration(elapsed)} rate=${rate}/s`,
      );
    }
  }

  const totalElapsed = Date.now() - startedAt;
  console.log("\n==== RESUMO ====");
  console.log(`Total de veículos:     ${vehicles.length}`);
  console.log(`Atualizados no banco:  ${updated}`);
  console.log(`Pulados (Angellira UNAVAILABLE): ${skipped}`);
  console.log(`Falhas:                ${failed}`);
  console.log(`Concorrência:          ${CONCURRENCY}`);
  console.log(`Tempo total:           ${formatDuration(totalElapsed)}`);
  console.log(`Throughput:            ${(vehicles.length / (totalElapsed / 1000)).toFixed(2)} placas/s`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
