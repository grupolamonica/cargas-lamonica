/**
 * Importa veiculos do JSON do Angellira para a tabela public.vehicles.
 * Separa por posicao: cab -> HORSE (cavalo); tow -> TRAILER_1 (carreta).
 *
 * Uso:
 *   node import-angellira-vehicles.mjs --file <path/resultado.json>
 *   node import-angellira-vehicles.mjs --file <path/resultado.json> --apply
 *
 * Sem --apply, o script roda em dry-run: valida o JSON, agrupa por posicao e
 * imprime contagens e amostras, sem tocar no banco.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

import "../infrastructure/config/load-env.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const BATCH_SIZE = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = null;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      filePath = path.resolve(args[++i]);
    } else if (args[i] === "--apply") {
      apply = true;
    }
  }

  if (!filePath) {
    console.error("Uso: node import-angellira-vehicles.mjs --file <caminho> [--apply]");
    process.exit(1);
  }

  return { filePath, apply };
}

function normalizePlate(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildDisplayName(item) {
  const marca = String(item.marca || "").trim();
  const modelo = String(item.modelo || "").trim();
  const joined = [marca, modelo].filter(Boolean).join(" ");
  return joined || null;
}

function buildAngelliraDetails(item) {
  const details = {};
  if (item.marca) details.brand = String(item.marca).trim();
  if (item.modelo) details.model = String(item.modelo).trim();
  if (item.ano) details.fabricationYear = String(item.ano).trim();
  if (item.chassi) details.chassis = String(item.chassi).trim();
  if (item.renavam) details.renavam = String(item.renavam).trim();
  if (item.cnpj_proprietario) details.ownerCnpj = String(item.cnpj_proprietario).trim();
  if (item.nome_proprietario) details.ownerName = String(item.nome_proprietario).trim();
  if (item.status) details.conformanceStatus = String(item.status).trim();
  if (item.placa_encontrada) details.plate = normalizePlate(item.placa_encontrada);
  return Object.keys(details).length > 0 ? details : null;
}

function mapVehicle(item) {
  const plateSource = item.placa_encontrada || item.placa_consultada;
  const plate = normalizePlate(plateSource);
  if (!plate) return null;

  const position = String(item.posicao || "").toLowerCase();
  let plateRole = null;
  let vehicleType = null;
  if (position === "cab") {
    plateRole = "HORSE";
    vehicleType = "TRUCK";
  } else if (position === "tow") {
    plateRole = "TRAILER_1";
  } else {
    return null;
  }

  const checkedAt = toIsoTimestamp(item.data_ultimo_envio);
  const status = String(item.status || "").trim();
  const isConforme = status === "Conforme";

  return {
    plate,
    plateRole,
    vehicleType,
    angelliraStatus: "FOUND",
    angelliraStatusText: status || null,
    angelliraDisplayName: buildDisplayName(item),
    angelliraLastSeenAt: checkedAt,
    angelliraCheckedAt: checkedAt,
    angelliraDetails: buildAngelliraDetails(item),
    source: "ANGELLIRA_IMPORT",
    isConforme,
  };
}

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) throw new Error("SUPABASE_DB_URL não configurado.");
  return new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
}

async function upsertBatch(client, rows) {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  const values = rows.flatMap((r) => [
    r.plate,
    r.vehicleType,
    r.plateRole,
    r.angelliraStatus,
    null, // angellira_valid_until — JSON Angellira não traz validade
    r.angelliraStatusText,
    r.angelliraDisplayName,
    r.angelliraLastSeenAt,
    r.angelliraCheckedAt,
    r.angelliraDetails ? JSON.stringify(r.angelliraDetails) : null,
    r.source,
  ]);

  const COLS = 11;
  const placeholders = rows
    .map(
      (_, i) =>
        `($${i * COLS + 1}, $${i * COLS + 2}, $${i * COLS + 3}, $${i * COLS + 4}, $${i * COLS + 5}, $${i * COLS + 6}, $${i * COLS + 7}, $${i * COLS + 8}, $${i * COLS + 9}, $${i * COLS + 10}::jsonb, $${i * COLS + 11})`,
    )
    .join(", ");

  const result = await client.query(
    `INSERT INTO public.vehicles (
        plate, vehicle_type, plate_role,
        angellira_status, angellira_valid_until, angellira_status_text,
        angellira_display_name, angellira_last_seen_at, angellira_checked_at,
        angellira_details, source
      ) VALUES ${placeholders}
      ON CONFLICT (plate) DO UPDATE SET
        plate_role              = COALESCE(EXCLUDED.plate_role, vehicles.plate_role),
        vehicle_type            = COALESCE(EXCLUDED.vehicle_type, vehicles.vehicle_type),
        angellira_status        = EXCLUDED.angellira_status,
        angellira_status_text   = EXCLUDED.angellira_status_text,
        angellira_display_name  = COALESCE(EXCLUDED.angellira_display_name, vehicles.angellira_display_name),
        angellira_last_seen_at  = EXCLUDED.angellira_last_seen_at,
        angellira_checked_at    = EXCLUDED.angellira_checked_at,
        angellira_details       = COALESCE(EXCLUDED.angellira_details, vehicles.angellira_details),
        source                  = EXCLUDED.source,
        updated_at              = now()
      RETURNING (xmax = 0) AS inserted`,
    values,
  );

  let inserted = 0;
  let updated = 0;
  for (const r of result.rows) {
    if (r.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

async function main() {
  const { filePath, apply } = parseArgs();

  console.log(`Lendo JSON: ${filePath}`);
  const raw = readFileSync(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error("JSON inválido:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error("Esperado um array de veículos no JSON.");
    process.exit(1);
  }

  const mapped = [];
  const skipped = [];
  const plateSeen = new Map();

  for (const item of data) {
    const mappedItem = mapVehicle(item);
    if (!mappedItem) {
      skipped.push({
        reason: !item?.placa_encontrada && !item?.placa_consultada ? "SEM_PLACA" : "POSICAO_DESCONHECIDA",
        placa: item?.placa_consultada || item?.placa_encontrada || null,
        posicao: item?.posicao || null,
      });
      continue;
    }

    const existing = plateSeen.get(mappedItem.plate);
    if (existing) {
      // Mantém o mais recente entre duplicatas no JSON
      const existingTs = existing.angelliraCheckedAt ? Date.parse(existing.angelliraCheckedAt) : 0;
      const nextTs = mappedItem.angelliraCheckedAt ? Date.parse(mappedItem.angelliraCheckedAt) : 0;
      if (nextTs > existingTs) {
        plateSeen.set(mappedItem.plate, mappedItem);
      }
      continue;
    }
    plateSeen.set(mappedItem.plate, mappedItem);
    mapped.push(mappedItem);
  }

  const dedupedRows = Array.from(plateSeen.values());
  const horseCount = dedupedRows.filter((r) => r.plateRole === "HORSE").length;
  const trailerCount = dedupedRows.filter((r) => r.plateRole === "TRAILER_1").length;
  const conformeCount = dedupedRows.filter((r) => r.isConforme).length;
  const naoConformeCount = dedupedRows.length - conformeCount;

  console.log("\n=== Resumo ===");
  console.log(`Total no JSON:         ${data.length}`);
  console.log(`Válidos (mapeados):    ${mapped.length}`);
  console.log(`Placas únicas:         ${dedupedRows.length}`);
  console.log(`  - Cavalo (HORSE):    ${horseCount}`);
  console.log(`  - Carreta (TRAILER_1): ${trailerCount}`);
  console.log(`Conformes:             ${conformeCount}`);
  console.log(`Não conformes:         ${naoConformeCount}`);
  console.log(`Ignorados:             ${skipped.length}`);

  if (skipped.length > 0) {
    const reasonCounts = {};
    for (const s of skipped) reasonCounts[s.reason] = (reasonCounts[s.reason] || 0) + 1;
    console.log("Motivos de skip:", reasonCounts);
    console.log("Exemplos:", skipped.slice(0, 3));
  }

  if (!apply) {
    console.log("\nDry-run: sem escrita no banco. Use --apply para gravar.");
    console.log("Amostras (3 primeiras):");
    console.log(JSON.stringify(dedupedRows.slice(0, 3), null, 2));
    return;
  }

  if (dedupedRows.length === 0) {
    console.log("Nada para gravar.");
    return;
  }

  const pool = createPool();
  const client = await pool.connect();
  let totalInserted = 0;
  let totalUpdated = 0;

  try {
    await client.query("BEGIN");

    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
      const batch = dedupedRows.slice(i, i + BATCH_SIZE);
      const { inserted, updated } = await upsertBatch(client, batch);
      totalInserted += inserted;
      totalUpdated += updated;
      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: +${inserted} novos / ${updated} atualizados`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Erro durante o import — ROLLBACK aplicado.");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n✅ Commit. Novos: ${totalInserted} · Atualizados: ${totalUpdated}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
