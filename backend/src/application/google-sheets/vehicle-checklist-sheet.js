import { parseCsv, fetchGoogleSheetCsv } from "./google-sheet-loads.js";
import { normalizePlate } from "../../domain/vehicle-checklist/status.js";

// Planilha do robô GRIFFI (aba "Checklist") que replica o LiraLOG a cada ~5 min.
// Lida por CSV público (mesma abordagem do sync de cargas — sem service account).
const DEFAULT_CHECKLIST_SHEET_ID = "1r39V0i-t56BjVuS-np-m5LxnAG8Ja625W9o-5Al7Ogk";
const DEFAULT_CHECKLIST_SHEET_NAME = "Checklist";

// BRT = UTC-3. As datas da planilha são hora de parede local; converto para
// instante para comparar com Date.now() sem depender do fuso do servidor.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

export function isVehicleChecklistEnabled() {
  return String(process.env.VEHICLE_CHECKLIST_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * URL de export CSV da aba Checklist. Prefere gviz por NOME da aba (robusto a
 * mudança de gid); se `VEHICLE_CHECKLIST_SHEET_GID` estiver setado, usa export por gid.
 */
export function getVehicleChecklistSheetUrl() {
  const sheetId = process.env.VEHICLE_CHECKLIST_SHEET_ID?.trim() || DEFAULT_CHECKLIST_SHEET_ID;
  if (!sheetId) return null;

  const gid = process.env.VEHICLE_CHECKLIST_SHEET_GID?.trim();
  if (gid) {
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  }

  const sheetName = process.env.VEHICLE_CHECKLIST_SHEET_NAME?.trim() || DEFAULT_CHECKLIST_SHEET_NAME;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

function stripAccents(value) {
  // Substituição explícita de vogais/ç acentuados (Veículo, Último, Cód,
  // Proprietário, Inclusão) — evita depender de NFD + combining marks.
  return value
    .replace(/[áàâã]/g, "a")
    .replace(/[éèê]/g, "e")
    .replace(/[íï]/g, "i")
    .replace(/[óòôõ]/g, "o")
    .replace(/[úü]/g, "u")
    .replace(/ç/g, "c");
}

function normHeader(value) {
  return stripAccents(String(value ?? "").toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Nome do campo → possíveis cabeçalhos (normalizados) na planilha.
const HEADER_ALIASES = {
  placa: ["placa"],
  tipoVeiculo: ["tipo veiculo"],
  statusRaw: ["status"],
  validade: ["data validade checklist", "data validade", "validade"],
  vencimento: ["vencimento"],
  ultimoStatus: ["ultimo status checklist", "ultimo status"],
  proprietario: ["proprietario"],
  dataInclusao: ["data inclusao"],
  codViagem: ["cod viagem"],
  codCheck: ["cod check monitor", "cod check"],
};

/** coluna "Vencimento" (dias restantes, ex.: "0", "16", "-45") → int ou null. */
function parseVencimentoDias(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number.parseInt(text.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** validade "08/05/2026 19:09:39" (BRT) → epoch ms. Retorna null se inválida/vazia. */
function parseBrDateTimeMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;

  const [, dd, mm, yyyy, hh = "0", mi = "0", ss = "0"] = match;
  const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  if (!Number.isFinite(ms)) return null;

  return ms + BRT_OFFSET_MS;
}

function buildColumnMap(headerRow) {
  const indexByHeader = new Map();
  headerRow.forEach((value, index) => {
    const key = normHeader(value);
    if (key && !indexByHeader.has(key)) indexByHeader.set(key, index);
  });

  const colByField = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (indexByHeader.has(alias)) {
        colByField[field] = indexByHeader.get(alias);
        break;
      }
    }
  }
  return colByField;
}

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    const normalized = rows[i].map(normHeader);
    if (normalized.includes("placa") && normalized.includes("status")) return i;
  }
  return -1;
}

/** Parseia o CSV da aba Checklist em itens crus por veículo (best-effort). */
export function parseVehicleChecklistCsv(csvText) {
  const rows = parseCsv(csvText);
  const headerRowIndex = findHeaderRow(rows);
  if (headerRowIndex === -1) return [];

  const colByField = buildColumnMap(rows[headerRowIndex]);
  if (colByField.placa === undefined) return [];

  const cell = (row, field) => {
    const col = colByField[field];
    return col === undefined ? "" : String(row[col] ?? "").trim();
  };

  const items = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const placa = cell(row, "placa");
    if (!placa) continue;

    const validadeLabel = cell(row, "validade");
    items.push({
      placa,
      placaNorm: normalizePlate(placa),
      tipoVeiculo: cell(row, "tipoVeiculo") || null,
      statusRaw: cell(row, "statusRaw") || null,
      ultimoStatus: cell(row, "ultimoStatus") || null,
      validadeLabel: validadeLabel || null,
      validadeMs: parseBrDateTimeMs(validadeLabel),
      vencimentoDias: parseVencimentoDias(cell(row, "vencimento")),
      proprietario: cell(row, "proprietario") || null,
      dataInclusao: cell(row, "dataInclusao") || null,
      codViagem: cell(row, "codViagem") || null,
      codCheck: cell(row, "codCheck") || null,
    });
  }
  return items;
}

/** Busca e parseia a aba Checklist. Retorna [] se desligada ou sem URL. */
export async function fetchVehicleChecklistRows(fetchImpl = fetch) {
  if (!isVehicleChecklistEnabled()) return [];
  const url = getVehicleChecklistSheetUrl();
  if (!url) return [];
  const csv = await fetchGoogleSheetCsv(fetchImpl, url);
  return parseVehicleChecklistCsv(csv);
}
