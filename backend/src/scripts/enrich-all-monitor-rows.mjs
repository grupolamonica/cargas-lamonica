#!/usr/bin/env node
/**
 * Backfill do enriquecimento do Monitor: consulta Angellira/ASPX de TODAS as
 * linhas pendentes (planilha + cargas do sistema) e persiste em
 * sheet_monitor_enriched. Roda no backend, em loop server-side — não depende do
 * frontend ficar aberto. Idempotente e re-executável (use como job agendado).
 *
 * Uso:
 *   node src/scripts/enrich-all-monitor-rows.mjs                # pendentes + stale (>6h)
 *   node src/scripts/enrich-all-monitor-rows.mjs --force        # re-consulta TODAS as linhas
 *   node src/scripts/enrich-all-monitor-rows.mjs --only-missing # só quem nunca foi consultado
 *   node src/scripts/enrich-all-monitor-rows.mjs --batch=300
 */
import "../infrastructure/config/load-env.js";
import { createSupabaseAdminClient } from "../infrastructure/supabase/admin-client.js";
import { enrichAllPendingMonitorRows } from "../application/operator-admin/sheet-monitor-enrichment.js";

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

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main() {
  const force = parseArg("force", false) === true;
  const onlyMissing = parseArg("only-missing", false) === true;
  const batchSize = Math.max(1, Number(parseArg("batch", 200)));
  const correlationId = `monitor-enrich-all-${Date.now()}`;
  const startedAt = Date.now();

  const mode = force ? "force (re-consulta tudo)" : onlyMissing ? "only-missing" : "pendentes + stale (>6h)";
  console.log(`[monitor-enrich] modo=${mode} batch=${batchSize}`);

  const supabaseClient = createSupabaseAdminClient();
  let lastLogged = 0;
  const result = await enrichAllPendingMonitorRows(supabaseClient, correlationId, {
    force,
    onlyMissing,
    batchSize,
    onProgress: ({ enriched, total, batches }) => {
      if (enriched - lastLogged >= 200 || enriched === total) {
        lastLogged = enriched;
        const pct = total > 0 ? Math.round((enriched / total) * 100) : 100;
        console.log(`[monitor-enrich] [${pct}%] enriched=${enriched}/${total} batches=${batches} elapsed=${formatDuration(Date.now() - startedAt)}`);
      }
    },
  });

  console.log("\n==== RESUMO MONITOR ENRICH ====");
  console.log(`Candidatos (planilha+sistema): ${result.candidates}`);
  console.log(`Processados:                   ${result.enriched}`);
  console.log(`Batches:                       ${result.batches}`);
  console.log(`Tempo total:                   ${formatDuration(Date.now() - startedAt)}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
