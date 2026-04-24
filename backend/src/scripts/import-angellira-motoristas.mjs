/**
 * Importa motoristas do JSON do Angellira para a tabela motoristas_historico.
 * Cruza cada motorista pelo CPF com a planilha ASPX (mesmo fluxo da candidatura).
 *
 * Uso:
 *   node import-angellira-motoristas.mjs --file <path/resultado.json>
 *   node import-angellira-motoristas.mjs --file <path/resultado.json> --apply
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

import "../infrastructure/config/load-env.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const ASPX_URL =
  process.env.ASPX_DRIVER_DIRECTORY_URL?.trim() ||
  "https://docs.google.com/spreadsheets/d/19nb3fyz-BEtIAs7s6aTP0inqBn2_0MzYGmuGZVgVfdc/export?format=csv";

const BATCH_SIZE = 100;
const CPF_HEADERS = ["staff_data_cpf", "data_staff_cpf"];
const NAME_HEADERS = ["staff_data_staff_name", "data_staff_name"];

// ─── Arg parsing ────────────────────────────────────────────────────────────

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
    console.error("Uso: node import-angellira-motoristas.mjs --file <caminho> [--apply]");
    process.exit(1);
  }

  return { filePath, apply };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseDateOnly(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─── CSV parsing (mesma lógica do aspx-directory.js) ────────────────────────

function parseCsv(text) {
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let insideQuotes = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (insideQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { currentCell += '"'; i++; continue; }
        insideQuotes = false;
        continue;
      }
      currentCell += ch;
      continue;
    }

    if (ch === '"') { insideQuotes = true; continue; }
    if (ch === ",") { currentRow.push(currentCell); currentCell = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }
    currentCell += ch;
  }

  if (currentCell !== "" || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

// ─── ASPX directory fetch ────────────────────────────────────────────────────

async function buildAspxIndex() {
  console.log(`Buscando planilha ASPX: ${ASPX_URL}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let csvText;
  try {
    const resp = await fetch(ASPX_URL, { headers: { Accept: "text/csv" }, signal: controller.signal });
    if (!resp.ok) throw new Error(`ASPX fetch falhou: HTTP ${resp.status}`);
    csvText = await resp.text();
  } finally {
    clearTimeout(timeout);
  }

  const rows = parseCsv(csvText);

  let headerIndex = -1;
  let header = [];

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const normalized = rows[i].map(normalizeHeader);
    const hasCpf = CPF_HEADERS.some((h) => normalized.includes(h));
    const hasName = NAME_HEADERS.some((h) => normalized.includes(h));
    if (hasCpf && hasName) { headerIndex = i; header = normalized; break; }
  }

  if (headerIndex < 0) throw new Error("Cabeçalho CPF/Nome não encontrado na planilha ASPX");

  const cpfIdx = CPF_HEADERS.map((h) => header.indexOf(h)).find((i) => i >= 0) ?? -1;
  const nameIdx = NAME_HEADERS.map((h) => header.indexOf(h)).find((i) => i >= 0) ?? -1;

  const index = new Map();

  for (const row of rows.slice(headerIndex + 1)) {
    const cpf = normalizeCpf(row[cpfIdx]);
    if (!cpf) continue;
    const displayName = typeof row[nameIdx] === "string" ? row[nameIdx].trim() : "";
    if (!index.has(cpf)) {
      index.set(cpf, { found: true, displayName: displayName || null });
    }
  }

  console.log(`Planilha ASPX carregada: ${index.size} motoristas indexados por CPF.`);
  return index;
}

// ─── Build rows for DB ───────────────────────────────────────────────────────

function buildRows(records, aspxIndex) {
  const now = new Date().toISOString();

  return records.map((record) => {
    const h = record.history || {};
    const cpf = normalizeCpf(h.driverCPF);
    const aspxEntry = cpf ? aspxIndex.get(cpf) : null;

    return {
      cpf,
      nome: (h.driverName || "").trim(),
      cnh: (h.driverCNH || "").trim() || null,
      cnh_validade: parseDateOnly(h.driverCNHValidity),
      cnh_categoria: (h.driverCNHCategory || "").trim() || null,
      cnh_security: h.driverCNHSecurity || null,
      rg: (h.driverRg || "").trim() || null,
      telefone: h.driverPhone || null,
      nascimento: parseDateOnly(h.driverBirth),
      driver_kind: h.driverKind || null,
      estado: h.driverState || null,
      cidade: h.driverCity || null,
      angellira_query_id: record.id || null,
      angellira_sent_date: record.sentDate || null,
      angellira_limit_date: record.limitDate || null,
      raw_json: JSON.stringify(record),
      aspx_found: Boolean(aspxEntry?.found),
      aspx_display_name: aspxEntry?.displayName ?? null,
      aspx_matched_at: aspxEntry?.found ? now : null,
    };
  });
}

// ─── DB upsert ───────────────────────────────────────────────────────────────

function createPool() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) throw new Error("SUPABASE_DB_URL não configurado.");
  // PgBouncer (Supabase) — rejectUnauthorized: false é suficiente para conexão poolada
  return new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
}

async function upsertBatch(client, rows) {
  if (rows.length === 0) return;

  const values = rows.flatMap((r) => [
    r.cpf,
    r.nome,
    r.cnh,
    r.cnh_validade,
    r.cnh_categoria,
    r.cnh_security,
    r.rg,
    r.telefone,
    r.nascimento,
    r.driver_kind,
    r.estado,
    r.cidade,
    r.angellira_query_id,
    r.angellira_sent_date,
    r.angellira_limit_date,
    r.raw_json,
    r.aspx_found,
    r.aspx_display_name,
    r.aspx_matched_at,
  ]);

  const COLS = 19;
  const placeholders = rows
    .map((_, i) => `(${Array.from({ length: COLS }, (__, j) => `$${i * COLS + j + 1}`).join(", ")})`)
    .join(", ");

  await client.query(
    `INSERT INTO public.motoristas_historico (
        cpf, nome, cnh, cnh_validade, cnh_categoria, cnh_security,
        rg, telefone, nascimento, driver_kind, estado, cidade,
        angellira_query_id, angellira_sent_date, angellira_limit_date,
        raw_json, aspx_found, aspx_display_name, aspx_matched_at
      ) VALUES ${placeholders}
      ON CONFLICT (cpf) DO UPDATE SET
        nome             = EXCLUDED.nome,
        cnh              = EXCLUDED.cnh,
        cnh_validade     = EXCLUDED.cnh_validade,
        cnh_categoria    = EXCLUDED.cnh_categoria,
        cnh_security     = EXCLUDED.cnh_security,
        rg               = EXCLUDED.rg,
        telefone         = EXCLUDED.telefone,
        nascimento       = EXCLUDED.nascimento,
        driver_kind      = EXCLUDED.driver_kind,
        estado           = EXCLUDED.estado,
        cidade           = EXCLUDED.cidade,
        angellira_query_id   = EXCLUDED.angellira_query_id,
        angellira_sent_date  = EXCLUDED.angellira_sent_date,
        angellira_limit_date = EXCLUDED.angellira_limit_date,
        raw_json         = EXCLUDED.raw_json,
        aspx_found       = EXCLUDED.aspx_found,
        aspx_display_name= EXCLUDED.aspx_display_name,
        aspx_matched_at  = EXCLUDED.aspx_matched_at,
        updated_at       = now()`,
    values,
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { filePath, apply } = parseArgs();

  console.log(`\nLendo JSON: ${filePath}`);
  const records = JSON.parse(readFileSync(filePath, "utf-8"));
  console.log(`Registros carregados: ${records.length}`);

  const aspxIndex = await buildAspxIndex();

  const rows = buildRows(records, aspxIndex);
  const semCpf = rows.filter((r) => !r.cpf).length;
  const comAspx = rows.filter((r) => r.aspx_found);
  const semAspx = rows.filter((r) => !r.aspx_found);

  console.log(`\n── Resumo ─────────────────────────────────────────────`);
  console.log(`  Total de motoristas : ${rows.length}`);
  console.log(`  Sem CPF válido      : ${semCpf}`);
  console.log(`  Com ASPX (Shopee)   : ${comAspx.length}`);
  console.log(`  Sem ASPX            : ${semAspx.length}`);

  if (comAspx.length > 0) {
    console.log(`\n── Amostra motoristas com ASPX (até 10) ──────────────`);
    for (const r of comAspx.slice(0, 10)) {
      const nomeAspx = r.aspx_display_name || "(sem nome na planilha)";
      console.log(`  ${r.nome.padEnd(40)} → ASPX: ${nomeAspx}`);
    }
  }

  if (!apply) {
    console.log(`\n[DRY-RUN] Nenhum dado gravado. Use --apply para confirmar.\n`);
    return;
  }

  console.log(`\nIniciando upsert em lotes de ${BATCH_SIZE}...`);
  const pool = createPool();
  const client = await pool.connect();
  let inserted = 0;

  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await upsertBatch(client, batch);
      inserted += batch.length;
      process.stdout.write(`\r  ${inserted}/${rows.length} inseridos...`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n\nFinalizado! ${inserted} motoristas gravados em motoristas_historico.`);
  console.log(`  → ${comAspx.length} com correspondência na planilha ASPX.`);
}

main().catch((err) => {
  console.error("\nErro fatal:", err.message);
  process.exit(1);
});
