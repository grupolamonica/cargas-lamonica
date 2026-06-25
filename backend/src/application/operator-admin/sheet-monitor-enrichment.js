import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { getPostgresPool } from "../../infrastructure/pg/postgres.js";
import { listSystemCargasForMonitor } from "./use-cases/list-system-cargas-monitor.js";

const STALE_HOURS = 6;
const BATCH_SIZE = 60;
const CONCURRENCY = 8;
const CALL_TIMEOUT_MS = 8_000;

function normalizePlate(p) {
  return (p || "").replace(/[\s\-.]/g, "").toUpperCase();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function runConcurrent(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]().catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// Best-effort fuzzy match: driver name (from sheet) → aspx record
function matchAspxDriver(name, aspxList) {
  if (!name) return null;
  const nl = name.toLowerCase().trim();
  let match = aspxList.find((d) => d.display_name?.toLowerCase().includes(nl));
  if (match) return match;
  match = aspxList.find((d) => d.display_name && d.display_name.length > 4 && nl.includes(d.display_name.toLowerCase()));
  if (match) return match;
  const firstWord = nl.split(/\s+/)[0];
  if (firstWord.length > 3) {
    match = aspxList.find((d) => d.display_name?.toLowerCase().startsWith(firstWord));
  }
  return match ?? null;
}

/**
 * Monta o registro de upsert de UMA linha (puro/testável). `row` = {lh, cargoId?,
 * motoristas, cavalo, carreta}. Para cargas do sistema, lh = 'cargo:<id>' e
 * cargoId preenchido → casa por cargo_id no frontend. Sempre devolve um registro
 * (mesmo sem motorista/placa) — a AUSÊNCIA de registro é o que vira "não consultado".
 */
export function buildEnrichedUpsertRow(row, ctx) {
  const { nameToCpf, nameToCpfDisplay, angelliraDrivers, vehiclesByPlate, angelliraVehicles } = ctx;
  const driverName = (row.motoristas || "").trim() || null;
  const cpf = driverName ? (nameToCpf[driverName] ?? null) : null;
  const dr = cpf ? angelliraDrivers[cpf] : null;

  const cavaloPl = normalizePlate(row.cavalo) || null;
  const carretaPl = normalizePlate(row.carreta) || null;

  function buildVehicle(plate) {
    if (!plate) return {};
    const db = vehiclesByPlate[plate];
    if (db) {
      return {
        source: "db",
        type: db.vehicle_type ?? null,
        found: db.angellira_status === "FOUND",
        status: db.angellira_status ?? null,
        validUntil: db.angellira_valid_until ?? null,
        statusText: db.angellira_status_text ?? null,
        display: db.angellira_display_name ?? null,
        details: db,
      };
    }
    const ang = angelliraVehicles[plate];
    if (!ang) return { source: "not_found", found: false };
    return {
      source: ang._source === "angellira" ? "angellira" : "not_found",
      type: ang.vehicleDetails?.type ?? null,
      found: ang.found ?? false,
      status: ang.status ?? null,
      validUntil: ang.validUntil ?? null,
      statusText: ang.statusText ?? null,
      display: ang.displayName ?? null,
      details: ang.vehicleDetails ?? null,
    };
  }

  const cavalo = buildVehicle(cavaloPl);
  const carreta = buildVehicle(carretaPl);

  return {
    lh: row.lh,
    cargo_id: row.cargoId ?? null,
    driver_name: driverName,
    aspx_cpf: cpf,
    aspx_display_name: driverName ? (nameToCpfDisplay[driverName] ?? null) : null,
    angellira_driver_found: dr?.found ?? null,
    angellira_driver_status: dr?.status ?? null,
    angellira_driver_valid_until: dr?.validUntil ?? null,
    angellira_driver_status_text: dr?.statusText ?? null,
    angellira_driver_details: dr?.driverDetails ? dr.driverDetails : null,

    cavalo_plate: cavaloPl,
    cavalo_source: cavalo.source ?? null,
    cavalo_type: cavalo.type ?? null,
    cavalo_angellira_found: cavalo.found ?? null,
    cavalo_angellira_status: cavalo.status ?? null,
    cavalo_angellira_valid_until: cavalo.validUntil ?? null,
    cavalo_angellira_status_text: cavalo.statusText ?? null,
    cavalo_angellira_display: cavalo.display ?? null,
    cavalo_details: cavalo.details ?? null,

    carreta_plate: carretaPl,
    carreta_source: carreta.source ?? null,
    carreta_type: carreta.type ?? null,
    carreta_angellira_found: carreta.found ?? null,
    carreta_angellira_status: carreta.status ?? null,
    carreta_angellira_valid_until: carreta.validUntil ?? null,
    carreta_angellira_status_text: carreta.statusText ?? null,
    carreta_angellira_display: carreta.display ?? null,
    carreta_details: carreta.details ?? null,

    enriched_at: new Date().toISOString(),
  };
}

/**
 * Núcleo: resolve ASPX/Angellira (com cache) p/ um conjunto de linhas e faz
 * upsert em sheet_monitor_enriched (onConflict lh). Linhas da planilha e do
 * sistema usam o mesmo pipeline.
 */
async function enrichRows(supabaseClient, batch, correlationId) {
  if (!Array.isArray(batch) || batch.length === 0) return 0;

  // ASPX drivers (full table — small, match in JS)
  const { data: aspxRows } = await supabaseClient
    .from("aspx_drivers")
    .select("cpf, display_name")
    .order("last_seen_at", { ascending: false });
  const aspxList = aspxRows || [];

  // Plates from vehicles cache
  const uniquePlates = [
    ...new Set(batch.flatMap((r) => [normalizePlate(r.cavalo), normalizePlate(r.carreta)]).filter(Boolean)),
  ];
  const { data: dbVehicles } = uniquePlates.length > 0
    ? await supabaseClient
        .from("vehicles")
        .select("plate, vehicle_type, plate_role, angellira_status, angellira_valid_until, angellira_status_text, angellira_display_name, angellira_details")
        .in("plate", uniquePlates)
    : { data: [] };
  const vehiclesByPlate = Object.fromEntries((dbVehicles || []).map((v) => [v.plate, v]));

  // Resolve CPFs via ASPX match
  const nameToCpf = {};
  const nameToCpfDisplay = {};
  for (const row of batch) {
    const name = (row.motoristas || "").trim();
    if (!name) continue;
    const aspx = matchAspxDriver(name, aspxList);
    if (aspx) {
      nameToCpf[name] = aspx.cpf;
      nameToCpfDisplay[name] = aspx.display_name;
    }
  }

  const uniqueCpfs = [...new Set(Object.values(nameToCpf))];

  // Driver cache (driver_profiles) — pula Angellira p/ CPF já validado
  const driverCacheByNormalizedCpf = {};
  if (uniqueCpfs.length > 0) {
    try {
      const pool = getPostgresPool();
      const { rows: cachedDriverRows } = await pool.query(
        `SELECT REPLACE(REPLACE(document_number, '.', ''), '-', '') AS cpf_norm,
                angellira_status, angellira_valid_until, angellira_status_text
         FROM public.driver_profiles
         WHERE angellira_checked_at IS NOT NULL
           AND REPLACE(REPLACE(document_number, '.', ''), '-', '') = ANY($1)`,
        [uniqueCpfs],
      );
      for (const r of cachedDriverRows) {
        driverCacheByNormalizedCpf[r.cpf_norm] = {
          found: r.angellira_status === "FOUND",
          status: r.angellira_status ?? null,
          validUntil: r.angellira_valid_until ?? null,
          statusText: r.angellira_status_text ?? null,
        };
      }
    } catch {
      // cache miss — segue com chamadas Angellira
    }
  }

  const cpfsToFetch = uniqueCpfs.filter((c) => !driverCacheByNormalizedCpf[c]);
  const platesToFetch = uniquePlates.filter((p) => !vehiclesByPlate[p]);

  const { lookupAngelliraDriverByCpf, lookupAngelliraPlate } =
    await import("../../infrastructure/angellira/angellira-client.js");

  const angelliraDrivers = { ...driverCacheByNormalizedCpf };
  const angelliraVehicles = {};

  const tasks = [
    ...cpfsToFetch.map((cpf) => async () => {
      try {
        angelliraDrivers[cpf] = await withTimeout(lookupAngelliraDriverByCpf(cpf, { correlationId }), CALL_TIMEOUT_MS);
      } catch {
        angelliraDrivers[cpf] = { found: false, status: "UNAVAILABLE", statusText: null, validUntil: null };
        logStructuredEvent("warn", "sheet-monitor-enrich.driver-timeout", { correlationId, cpf });
      }
    }),
    ...platesToFetch.map((plate) => async () => {
      try {
        const res = await withTimeout(lookupAngelliraPlate(plate, { correlationId }), CALL_TIMEOUT_MS);
        angelliraVehicles[plate] = { ...res, _source: "angellira" };
      } catch {
        angelliraVehicles[plate] = { found: false, status: "UNAVAILABLE", _source: "not_found" };
        logStructuredEvent("warn", "sheet-monitor-enrich.plate-timeout", { correlationId, plate });
      }
    }),
  ];

  await runConcurrent(tasks, CONCURRENCY);

  const ctx = { nameToCpf, nameToCpfDisplay, angelliraDrivers, vehiclesByPlate, angelliraVehicles };
  const upsertRows = batch.map((row) => buildEnrichedUpsertRow(row, ctx));

  const { error: upsertError } = await supabaseClient
    .from("sheet_monitor_enriched")
    .upsert(upsertRows, { onConflict: "lh" });

  if (upsertError) {
    logStructuredEvent("error", "sheet-monitor-enrich.upsert-error", { correlationId, message: upsertError.message });
  }
  return batch.length;
}

// Cargas do sistema (sheet_lh nulo) projetadas no shape do pipeline de enrich.
async function loadSystemEnrichCandidates(supabaseClient) {
  try {
    const sys = await listSystemCargasForMonitor(supabaseClient);
    return sys
      .filter((c) => c.cargoId)
      .map((c) => ({
        lh: `cargo:${c.cargoId}`,
        cargoId: c.cargoId,
        motoristas: c.motoristas || "",
        cavalo: c.cavalo || "",
        carreta: c.carreta || "",
      }));
  } catch {
    return [];
  }
}

/**
 * Enriquece um lote de linhas do Monitor (planilha + cargas do sistema) com
 * Angellira + ASPX. Só re-processa o que está pendente/stale (> STALE_HOURS),
 * salvo force=true. Cargas do sistema entram pelo cargo_id (lh = 'cargo:<id>').
 */
export async function enrichSheetMonitorRows(supabaseClient, correlationId, { force = false, forceSessionStart = null } = {}) {
  // 1. Snapshot da planilha (não-fatal se faltar — ainda enriquece o sistema)
  let rawRows = [];
  try {
    const { data: snapshot } = await supabaseClient
      .from("sheet_monitor_snapshot")
      .select("rows_json")
      .eq("id", 1)
      .single();
    rawRows = Array.isArray(snapshot?.rows_json) ? snapshot.rows_json : [];
  } catch {
    rawRows = [];
  }
  const sheetRows = [...new Map(rawRows.filter((r) => r.lh).map((r) => [r.lh, r])).values()];

  // 1b. Cargas do sistema (sempre consultadas também)
  const systemRows = await loadSystemEnrichCandidates(supabaseClient);

  const candidates = [...sheetRows, ...systemRows];
  if (candidates.length === 0) return { enriched: 0, remaining: 0 };

  // 2. Pendentes/stale (keyed por lh — sistema usa 'cargo:<id>')
  let rowsToProcess = candidates;
  if (force && forceSessionStart) {
    const { data: alreadyDone } = await supabaseClient
      .from("sheet_monitor_enriched")
      .select("lh")
      .gte("enriched_at", forceSessionStart)
      .limit(50000);
    const doneSet = new Set((alreadyDone || []).map((r) => r.lh));
    rowsToProcess = candidates.filter((r) => !doneSet.has(r.lh));
  } else if (!force) {
    const staleTs = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString();
    const { data: fresh } = await supabaseClient
      .from("sheet_monitor_enriched")
      .select("lh")
      .gte("enriched_at", staleTs)
      .limit(50000);
    const freshSet = new Set((fresh || []).map((r) => r.lh));
    rowsToProcess = candidates.filter((r) => !freshSet.has(r.lh));
  }

  const batch = rowsToProcess.slice(0, BATCH_SIZE);
  const remaining = rowsToProcess.length - batch.length;
  if (batch.length === 0) return { enriched: 0, remaining: 0 };

  await enrichRows(supabaseClient, batch, correlationId);
  return { enriched: batch.length, remaining };
}

/**
 * Enriquece UMA carga do sistema por id (fire-and-forget pós-insert/update).
 * Sempre faz upsert — mesmo sem motorista/placa grava a linha esqueleto, p/ o
 * selo nunca ficar "não consultado". Best-effort: NÃO lança.
 */
export async function enrichSystemCargoById(supabaseClient, cargoId, { correlationId = null } = {}) {
  if (!cargoId) return;
  try {
    const { data } = await supabaseClient
      .from("cargas")
      .select("id, alloc_motorista, alloc_cavalo, alloc_carreta")
      .eq("id", cargoId)
      .maybeSingle();
    if (!data) return;
    const row = {
      lh: `cargo:${cargoId}`,
      cargoId,
      motoristas: (data.alloc_motorista || "").trim(),
      cavalo: data.alloc_cavalo || "",
      carreta: data.alloc_carreta || "",
    };
    await enrichRows(supabaseClient, [row], correlationId);
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.system-cargo-failed", {
      correlationId,
      cargoId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
