#!/usr/bin/env node
/**
 * Enriquece TODAS as linhas do sheet_monitor_snapshot via Angellira + ASPX.
 * Processa em lotes de 60 (BATCH_SIZE do enrichSheetMonitorRows) até remaining=0.
 * Salva em sheet_monitor_enriched e imprime JSON completo ao final.
 *
 * Uso:
 *   node backend/server/scripts/enrich-all-sheet-rows.mjs
 *   node backend/server/scripts/enrich-all-sheet-rows.mjs --output=results.json
 *   node backend/server/scripts/enrich-all-sheet-rows.mjs --limit=20   # subset para teste
 */
import "../config/load-env.js";
import { createClient } from "@supabase/supabase-js";
import { enrichSheetMonitorRows } from "../services/operator-admin/sheet-monitor-enrichment.js";
import { writeFile } from "fs/promises";
import { resolve } from "path";

process.on("unhandledRejection", (reason) => {
  console.error("[enrich-all] Unhandled rejection:", reason);
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

const OUTPUT_FILE = parseArg("output", null);
const LIMIT = parseArg("limit", null) ? Number(parseArg("limit", null)) : null;
const FORCE_RESET = Boolean(parseArg("force-reset", false));
const MAX_BATCHES = 200; // safety guard — prevents infinite loops
// Delay between batches to avoid Angellira rate-limit (default: 3s).
// The service runs 8 concurrent Angellira calls per batch; without delay
// a 200-batch run sends ~1600 calls/min and triggers IP/account blocking.
const BATCH_DELAY_MS = Number(parseArg("batch-delay-ms", 3000));

function makeSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[enrich-all] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.");
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function fetchAllEnriched(client) {
  const { data, error } = await client
    .from("sheet_monitor_enriched")
    .select("*")
    .order("enriched_at", { ascending: false });

  if (error) {
    console.error("[enrich-all] Erro ao buscar sheet_monitor_enriched:", error.message);
    return [];
  }
  return data || [];
}

async function main() {
  const correlationId = `enrich-all-${Date.now()}`;
  const startedAt = Date.now();
  const client = makeSupabaseAdmin();

  // Check snapshot row count upfront
  const { data: snap } = await client
    .from("sheet_monitor_snapshot")
    .select("rows_json")
    .eq("id", 1)
    .single();

  const totalRows = Array.isArray(snap?.rows_json) ? snap.rows_json.length : 0;
  console.error(`[enrich-all] Linhas no snapshot: ${totalRows}`);

  if (totalRows === 0) {
    console.error("[enrich-all] Snapshot vazio. Rode o sheet-sync primeiro.");
    process.exit(0);
  }

  let totalEnriched = 0;
  let batch = 0;

  if (FORCE_RESET) {
    // Reset enriched_at to epoch so all rows appear stale, forcing full re-enrichment.
    // Only use on clean re-runs; normally the script resumes from where it left off.
    console.error("[enrich-all] --force-reset: zerando enriched_at de todas as linhas...");
    const { error: resetError } = await client
      .from("sheet_monitor_enriched")
      .update({ enriched_at: new Date(0).toISOString() })
      .neq("lh", "");
    if (resetError) {
      console.error("[enrich-all] Aviso: falha ao resetar enriched_at:", resetError.message);
    }
  }

  console.error(`[enrich-all] Iniciando enriquecimento (${totalRows} linhas)...`);

  while (batch < MAX_BATCHES) {
    batch++;
    const result = await enrichSheetMonitorRows(client, correlationId);

    if (result.error) {
      console.error(`[enrich-all] Erro no batch ${batch}:`, result.error);
      break;
    }

    totalEnriched += result.enriched;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(
      `  Batch ${batch}: enriched=${result.enriched} remaining=${result.remaining} elapsed=${elapsed}s total=${totalEnriched}`,
    );

    if (result.remaining === 0 || result.enriched === 0) break;

    if (LIMIT && totalEnriched >= LIMIT) {
      console.error(`[enrich-all] Limite --limit=${LIMIT} atingido.`);
      break;
    }

    // Throttle between batches to avoid Angellira rate-limit
    if (BATCH_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n[enrich-all] Concluído: ${totalEnriched} linhas em ${elapsed}s (${batch} batches)`);

  // Fetch all enriched rows and output JSON
  console.error("[enrich-all] Buscando resultados do banco...");
  const rows = await fetchAllEnriched(client);

  const json = JSON.stringify(rows, null, 2);

  if (OUTPUT_FILE) {
    const outPath = resolve(process.cwd(), OUTPUT_FILE);
    await writeFile(outPath, json, "utf8");
    console.error(`[enrich-all] Salvo em: ${outPath}`);
  }

  // Always print JSON to stdout
  process.stdout.write(json + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("[enrich-all] Fatal:", err);
  process.exit(1);
});
