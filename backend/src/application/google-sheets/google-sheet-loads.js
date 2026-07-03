import crypto from "node:crypto";

import "../../infrastructure/config/load-env.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { createSupabaseAdminClient } from "../../infrastructure/supabase/admin-client.js";
import { normalizeVehicleProfile } from "../../domain/vehicle-profiles.js";
import { baseRouteValues as BASE_ROUTE_VALUES } from "../../domain/operator-admin/base-route-values.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEET_ID?.trim() || "";
const DEFAULT_SHEET_GID = process.env.GOOGLE_SHEET_GID?.trim() || "0";
const DEFAULT_PROFILE = "CARRETA";
const DEFAULT_PUBLISHED_STATUS = "OPEN";
const DEFAULT_SHEET_CLIENT_NAME = process.env.GOOGLE_SHEET_DEFAULT_CLIENT_NAME?.trim() || "Shopee";
const DELETE_BATCH_SIZE = 100;
const EXISTING_SHEET_LOADS_PAGE_SIZE = 1000;
const ROUTE_CATALOG_PAGE_SIZE = 1000;
const ROUTE_TEMPLATE_PAGE_SIZE = 1000;
const SHEET_LOADS_TABLE = "cargas";
const SHEET_CLIENTS_TABLE = "clientes";
const ROUTE_CATALOG_TABLE = "route_metrics_cache";
const SHEET_LOADS_REQUIRED_HEADERS = [
  "lh",
  "tipo",
  "data carregamento",
  "data descarga",
  "motoristas",
  "origem",
  "destino",
  "status",
];
const SHEET_LOAD_VALUE_HEADERS = [
  "valor",
  "valor frete",
  "valor do frete",
  "frete",
  "vl frete",
  "pagamento",
  "pgto",
];
function normalizeText(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeRouteLocation(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function stripRouteStateSuffix(value) {
  return value.replace(/\s*\/\s*[a-z]{2}$/i, "").trim();
}

function stripOperationalLocationSuffix(value) {
  return value
    .replace(/[-_/]\s*\d+\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeRouteLookupLocation(value) {
  const normalizedValue = stripOperationalLocationSuffix(stripRouteStateSuffix(normalizeRouteLocation(value)));

  if (!normalizedValue) {
    return "";
  }

  if (/\bsj rio preto\b/.test(normalizedValue) || /\bsao jose do rio preto\b/.test(normalizedValue)) {
    return "sao jose do rio preto";
  }

  if (/\bpedreira\b/.test(normalizedValue) || /\bsao paulo\b/.test(normalizedValue)) {
    return "sao paulo";
  }

  if (/\bsalvador\b/.test(normalizedValue)) {
    return "salvador";
  }

  if (/\bsimoes filho\b/.test(normalizedValue)) {
    return "simoes filho";
  }

  if (/\bjaboatao dos guararapes\b/.test(normalizedValue)) {
    return "jaboatao dos guararapes";
  }

  if (/\bfeira de santana\b/.test(normalizedValue)) {
    return "feira de santana";
  }

  if (/\bcampo grande\b/.test(normalizedValue)) {
    return "campo grande";
  }

  if (/\bcamacari\b/.test(normalizedValue)) {
    return "camacari";
  }

  return normalizedValue;
}

function createRouteLookupKeys(origin, destination) {
  const originKey = normalizeRouteLocation(origin);
  const destinationKey = normalizeRouteLocation(destination);
  const originWithoutState = stripRouteStateSuffix(originKey);
  const destinationWithoutState = stripRouteStateSuffix(destinationKey);
  const canonicalOrigin = canonicalizeRouteLookupLocation(origin);
  const canonicalDestination = canonicalizeRouteLookupLocation(destination);

  const originVariants = Array.from(
    new Set([originKey, originWithoutState, canonicalOrigin].filter((value) => value !== "")),
  );
  const destinationVariants = Array.from(
    new Set([destinationKey, destinationWithoutState, canonicalDestination].filter((value) => value !== "")),
  );

  return Array.from(
    new Set(
      originVariants.flatMap((originVariant) =>
        destinationVariants.map((destinationVariant) => `${originVariant}|${destinationVariant}`),
      ),
    ),
  );
}

function registerRouteDefaults(defaultsByKey, origin, destination, defaults) {
  if (typeof origin !== "string" || typeof destination !== "string" || !origin.trim() || !destination.trim()) {
    return;
  }

  createRouteLookupKeys(origin, destination).forEach((routeKey) => {
    if (!defaultsByKey.has(routeKey)) {
      defaultsByKey.set(routeKey, defaults);
    }
  });
}

function resolveRouteDefaults(defaultsByKey, origin, destination) {
  for (const routeKey of createRouteLookupKeys(origin, destination)) {
    const matchedDefaults = defaultsByKey.get(routeKey);

    if (matchedDefaults) {
      return matchedDefaults;
    }
  }

  return null;
}

function createBaseRouteValueMap() {
  const baseRouteValuesByKey = new Map();

  BASE_ROUTE_VALUES.forEach((route) => {
    registerRouteDefaults(baseRouteValuesByKey, route.origin, route.destination, {
      valor: route.value,
    });
  });

  return baseRouteValuesByKey;
}

const BASE_ROUTE_VALUES_BY_KEY = createBaseRouteValueMap();

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatUuidFromHex(hex) {
  const cleanHex = hex.slice(0, 32).padEnd(32, "0");
  const timeLow = cleanHex.slice(0, 8);
  const timeMid = cleanHex.slice(8, 12);
  const timeHi = ((Number.parseInt(cleanHex.slice(12, 16), 16) & 0x0fff) | 0x5000)
    .toString(16)
    .padStart(4, "0");
  const clockSeq = ((Number.parseInt(cleanHex.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, "0");
  const node = cleanHex.slice(20, 32);

  return `${timeLow}-${timeMid}-${timeHi}-${clockSeq}-${node}`;
}

export function createSheetLoadId(sheetLh) {
  const hash = crypto.createHash("sha1").update(`sheet-load:${sheetLh}`).digest("hex");
  return formatUuidFromHex(hash);
}

export function parseCsv(text) {
  const sourceText = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];

    if (insideQuotes) {
      if (char === '"') {
        const nextChar = sourceText[index + 1];

        if (nextChar === '"') {
          cell += '"';
          index += 1;
          continue;
        }

        insideQuotes = false;
        continue;
      }

      cell += char;
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);

      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }

      row = [];
      cell = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    cell += char;
  }

  row.push(cell);

  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeaderName(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function buildHeaderIndex(headerRow) {
  const indexByHeader = new Map();

  headerRow.forEach((value, index) => {
    const normalizedHeader = normalizeHeaderName(value);

    if (normalizedHeader && !indexByHeader.has(normalizedHeader)) {
      indexByHeader.set(normalizedHeader, index);
    }
  });

  return indexByHeader;
}

function findHeaderRowIndex(rows) {
  return rows.findIndex((row) => {
    const normalizedHeaders = new Set(row.map((cell) => normalizeHeaderName(cell)));

    return SHEET_LOADS_REQUIRED_HEADERS.every((header) => normalizedHeaders.has(header));
  });
}

function getCell(row, headerIndex, headerName) {
  const normalizedHeader = normalizeHeaderName(headerName);
  const index = headerIndex.get(normalizedHeader);

  if (index === undefined) {
    return "";
  }

  return (row[index] ?? "").trim();
}

function findFirstAvailableHeader(headerIndex, headerNames) {
  return headerNames.find((headerName) => headerIndex.has(normalizeHeaderName(headerName))) || null;
}

function chunkArray(values, chunkSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

async function fetchExistingSheetLoads(supabaseClient) {
  const existingLoads = [];

  for (let offset = 0; ; offset += EXISTING_SHEET_LOADS_PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from(SHEET_LOADS_TABLE)
      .select("id, sheet_lh, valor, bonus, cliente_id, perfil, distancia_km, duracao_horas, status, is_template, created_by")
      .not("sheet_lh", "is", null)
      // Só cargas que vieram do sync da planilha (sheet_synced_at preenchido).
      // Cargas importadas manualmente têm sheet_lh mas sheet_synced_at NULL —
      // não pertencem à planilha Shopee e NÃO devem ser expiradas pelo sync.
      .not("sheet_synced_at", "is", null)
      .order("sheet_lh", { ascending: true })
      .range(offset, offset + EXISTING_SHEET_LOADS_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const pageRows = data || [];
    existingLoads.push(...pageRows);

    if (pageRows.length < EXISTING_SHEET_LOADS_PAGE_SIZE) {
      break;
    }
  }

  return existingLoads;
}

async function fetchRouteCatalogRows(supabaseClient) {
  const routeCatalogRows = [];

  for (let offset = 0; ; offset += ROUTE_CATALOG_PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from(ROUTE_CATALOG_TABLE)
      .select(
        "origin_key, destination_key, origem, destino, distancia_km, duracao_horas, perfil_padrao, valor_padrao, bonus_padrao, ativa, updated_at",
      )
      .eq("ativa", true)
      .order("updated_at", { ascending: false })
      .range(offset, offset + ROUTE_CATALOG_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const pageRows = data || [];
    routeCatalogRows.push(...pageRows);

    if (pageRows.length < ROUTE_CATALOG_PAGE_SIZE) {
      break;
    }
  }

  return routeCatalogRows;
}

async function fetchRouteTemplateRows(supabaseClient) {
  const routeTemplateRows = [];

  for (let offset = 0; ; offset += ROUTE_TEMPLATE_PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from(SHEET_LOADS_TABLE)
      .select("origem, destino, perfil, valor, bonus, cliente_id, distancia_km, duracao_horas, updated_at")
      .eq("is_template", true)
      .order("updated_at", { ascending: false })
      .range(offset, offset + ROUTE_TEMPLATE_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const pageRows = data || [];
    routeTemplateRows.push(...pageRows);

    if (pageRows.length < ROUTE_TEMPLATE_PAGE_SIZE) {
      break;
    }
  }

  return routeTemplateRows;
}

function createRouteCatalogDefaultsMap(routeCatalogRows) {
  const defaultsByKey = new Map();

  routeCatalogRows.forEach((routeCatalogRow) => {
    const defaults = {
      perfil: routeCatalogRow.perfil_padrao ?? null,
      valor: routeCatalogRow.valor_padrao ?? null,
      bonus: routeCatalogRow.bonus_padrao ?? null,
      distancia_km: routeCatalogRow.distancia_km ?? null,
      duracao_horas: routeCatalogRow.duracao_horas ?? null,
    };

    if (routeCatalogRow.origin_key && routeCatalogRow.destination_key) {
      registerRouteDefaults(defaultsByKey, routeCatalogRow.origin_key, routeCatalogRow.destination_key, defaults);
    }

    registerRouteDefaults(defaultsByKey, routeCatalogRow.origem, routeCatalogRow.destino, defaults);
  });

  return defaultsByKey;
}

function createRouteTemplateDefaultsMap(routeTemplateRows) {
  const defaultsByKey = new Map();

  routeTemplateRows.forEach((routeTemplateRow) => {
    registerRouteDefaults(defaultsByKey, routeTemplateRow.origem, routeTemplateRow.destino, {
      perfil: routeTemplateRow.perfil ?? null,
      valor: routeTemplateRow.valor ?? null,
      bonus: routeTemplateRow.bonus ?? null,
      cliente_id: routeTemplateRow.cliente_id ?? null,
      distancia_km: routeTemplateRow.distancia_km ?? null,
      duracao_horas: routeTemplateRow.duracao_horas ?? null,
    });
  });

  return defaultsByKey;
}

function pickFirstFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return null;
}

function normalizeSpreadsheetDateTimeValue(value) {
  const trimmedValue = String(value || "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (!trimmedValue) {
    return "";
  }

  const normalizedValue = trimmedValue.replace(
    /^(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})(\d{1,2}:\d{2}(?::\d{2})?)$/,
    "$1 $2",
  );

  return normalizedValue.replace(/\s+/g, " ");
}

function parseBrazilianDateTime(value) {
  const trimmedValue = normalizeSpreadsheetDateTimeValue(value);

  if (!trimmedValue) {
    throw new Error("Empty datetime value");
  }

  const [datePart, timePart = "00:00:00"] = trimmedValue.split(/\s+/);
  const dateSegments = datePart.split(/[/-]/).map((part) => Number(part));
  let day;
  let month;
  let year;

  if (dateSegments.length !== 3 || dateSegments.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid datetime value: ${value}`);
  }

  if (datePart.match(/^\d{4}[/-]/)) {
    [year, month, day] = dateSegments;
  } else {
    [day, month, year] = dateSegments;
  }

  const [hours = 0, minutes = 0, seconds = 0] = timePart.split(":").map((part) => Number(part));

  if (
    !day ||
    !month ||
    !year ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    throw new Error(`Invalid datetime value: ${value}`);
  }

  return {
    date: `${year.toString().padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
    time: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`,
  };
}

function formatBrazilianDateTimeLabel(dateTime) {
  const [year, month, day] = dateTime.date.split("-");

  return `${day}/${month}/${year} ${dateTime.time.slice(0, 5)}`;
}

function parseSpreadsheetCurrency(value) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return undefined;
  }

  const cleanedValue = trimmedValue
    .replace(/^R\$\s*/i, "")
    .replace(/\s+/g, "")
    .replace(/[^\d,.-]/g, "");

  if (!/\d/.test(cleanedValue)) {
    return null;
  }

  const normalizedValue = cleanedValue.includes(",")
    ? cleanedValue.replace(/\./g, "").replace(",", ".")
    : cleanedValue.replace(/,/g, "");
  const parsedValue = Number(normalizedValue);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function formatSpreadsheetLocation(value) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  const underscoreParts = trimmedValue
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  const ufIndex = underscoreParts.findIndex((part) => /^[A-Za-z]{2}$/.test(part));

  if (ufIndex === -1) {
    return trimmedValue.replace(/\s+/g, " ");
  }

  const uf = underscoreParts[ufIndex].toUpperCase();
  const locationParts = underscoreParts.slice(ufIndex + 1);

  if (locationParts.length === 0) {
    return underscoreParts.slice(0, ufIndex).join(" ").replace(/\s+/g, " ");
  }

  const location = locationParts.join(" ").replace(/\s+/g, " ").trim();

  return `${location} / ${uf}`;
}

export function getSheetExportUrl() {
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim() || DEFAULT_SHEET_ID;
  const sheetGid = process.env.GOOGLE_SHEET_GID?.trim() || DEFAULT_SHEET_GID;

  if (!sheetId) {
    return null;
  }

  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${sheetGid}`;
}

/**
 * Erro tipado lançado quando o `clientes.nome` esperado pelo sync não existe.
 *
 * Incidente 2026-05-18: cliente "Shopee" foi renomeado para "E-COMMERCE" no DB
 * de produção e o `GOOGLE_SHEET_DEFAULT_CLIENT_NAME` env var não estava setada.
 * O `throw new Error("Missing required sheet client record: Shopee")` opaco
 * derrubou TODOS os caminhos de sync (periódico, sync-sheet manual,
 * ensureDriverLoadsSheetFresh) por 4 dias sem alerta — só descobrimos por
 * inspeção manual de logs após uma queixa do operador.
 *
 * O guard estruturado abaixo emite `[security-event] sheet.client.missing`
 * que o Loki/promtail/Grafana stack já indexam, com `clientName`,
 * `availableClientsHint` (quantos clientes existem) e `remediation` (hint
 * acionável). Continua lançando — sync sem o client_id correto não faz
 * sentido — mas agora cada falha é uma linha de log alarmável.
 */
export class SheetClientNotConfiguredError extends Error {
  constructor(clientName, { availableClientsCount = null } = {}) {
    super(
      `Sheet client record not found: "${clientName}". `
      + `Verify env GOOGLE_SHEET_DEFAULT_CLIENT_NAME matches an existing `
      + `public.clientes.nome row, or insert/rename the client.`,
    );
    this.name = "SheetClientNotConfiguredError";
    this.code = "SHEET_CLIENT_NOT_CONFIGURED";
    this.clientName = clientName;
    this.availableClientsCount = availableClientsCount;
  }
}

async function resolveSheetClientId(supabaseClient, clientName = DEFAULT_SHEET_CLIENT_NAME) {
  const trimmedClientName = clientName.trim();

  if (!trimmedClientName) {
    logStructuredEvent("error", "sheet.client.name_missing", {
      remediation: "Set env GOOGLE_SHEET_DEFAULT_CLIENT_NAME or pass clientName explicitly.",
    });
    throw new SheetClientNotConfiguredError("(empty)");
  }

  const { data, error } = await supabaseClient
    .from(SHEET_CLIENTS_TABLE)
    .select("id")
    .eq("nome", trimmedClientName)
    .range(0, 0);

  if (error) {
    throw error;
  }

  const [client] = data || [];

  if (!client?.id) {
    // Conta clientes existentes para enriquecer o alarme (não bloqueia se falhar).
    let availableClientsCount = null;
    try {
      const { count } = await supabaseClient
        .from(SHEET_CLIENTS_TABLE)
        .select("id", { count: "exact", head: true });
      availableClientsCount = count ?? null;
    } catch {
      // count é melhor-esforço — não impede o throw principal.
    }

    logStructuredEvent("error", "sheet.client.missing", {
      clientName: trimmedClientName,
      table: SHEET_CLIENTS_TABLE,
      availableClientsCount,
      envVar: "GOOGLE_SHEET_DEFAULT_CLIENT_NAME",
      remediation:
        "Cliente esperado pelo sync não existe em public.clientes.nome. "
        + "Verificar env GOOGLE_SHEET_DEFAULT_CLIENT_NAME no backend.env, "
        + "ou renomear/inserir a linha em clientes.",
    });

    throw new SheetClientNotConfiguredError(trimmedClientName, {
      availableClientsCount,
    });
  }

  return client.id;
}

export function parseAvailableGoogleSheetLoads(csvText, options = {}) {
  const { onInvalidRow } = options;
  const rows = parseCsv(csvText);
  const headerRowIndex = findHeaderRowIndex(rows);

  if (headerRowIndex === -1) {
    const foundHeaders = rows.length > 0
      ? [...new Set(rows.slice(0, 5).flatMap((row) => row.map((cell) => normalizeHeaderName(cell)).filter(Boolean)))]
      : [];
    const missingHeaders = SHEET_LOADS_REQUIRED_HEADERS.filter((h) => !foundHeaders.includes(h));
    throw new Error(
      `Unable to find the Google Sheet header row. Missing required headers: [${missingHeaders.join(", ")}]. Found in first rows: [${foundHeaders.slice(0, 15).join(", ")}].`,
    );
  }

  const headerRow = rows[headerRowIndex];
  const headerIndex = buildHeaderIndex(headerRow);
  const valueHeaderName = findFirstAvailableHeader(headerIndex, SHEET_LOAD_VALUE_HEADERS);
  const availableLoads = [];

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const lh = getCell(row, headerIndex, "lh");
    const tipo = getCell(row, headerIndex, "tipo");
    const dataCarregamento = getCell(row, headerIndex, "data carregamento");
    const dataCarregamentoFallback = getCell(row, headerIndex, "data carregamento2");
    const dataDescarga = getCell(row, headerIndex, "data descarga");
    const motoristas = getCell(row, headerIndex, "motoristas");
    const origem = getCell(row, headerIndex, "origem");
    const destino = getCell(row, headerIndex, "destino");
    const status = getCell(row, headerIndex, "status");
    const rawValue = valueHeaderName ? getCell(row, headerIndex, valueHeaderName) : "";

    if (!lh || motoristas !== "" || status !== "" || !origem || !destino) {
      continue;
    }

    const rawDateTime = dataCarregamento || dataCarregamentoFallback;

    if (!rawDateTime) {
      continue;
    }

    let parsedDateTime;
    let parsedUnloadDateTime;

    try {
      parsedDateTime = parseBrazilianDateTime(
        dataCarregamento ? dataCarregamento : `${dataCarregamentoFallback} 00:00:00`,
      );
      parsedUnloadDateTime = dataDescarga ? parseBrazilianDateTime(dataDescarga) : null;
    } catch (error) {
      onInvalidRow?.({
        rowIndex: index + 1,
        lh,
        origem,
        destino,
        dataCarregamento: rawDateTime,
        dataDescarga,
        message: error instanceof Error ? error.message : "Invalid spreadsheet datetime value.",
      });
      continue;
    }

    availableLoads.push({
      lh,
      tipo: tipo || null,
      data: parsedDateTime.date,
      horario: parsedDateTime.time,
      valor: valueHeaderName ? parseSpreadsheetCurrency(rawValue) : undefined,
      carregamentoLabel: formatBrazilianDateTimeLabel(parsedDateTime),
      descargaLabel: parsedUnloadDateTime ? formatBrazilianDateTimeLabel(parsedUnloadDateTime) : null,
      origem: formatSpreadsheetLocation(origem),
      destino: formatSpreadsheetLocation(destino),
      rawOrigem: origem,
      rawDestino: destino,
      rawDateTime,
    });
  }

  const dedupedLoads = new Map();

  availableLoads.forEach((load) => {
    dedupedLoads.set(load.lh, load);
  });

  return Array.from(dedupedLoads.values()).sort((loadA, loadB) => {
    const dateCompare = loadA.data.localeCompare(loadB.data);

    if (dateCompare !== 0) {
      return dateCompare;
    }

    return loadA.horario.localeCompare(loadB.horario);
  });
}

export function parseAllGoogleSheetRows(csvText) {
  const rows = parseCsv(csvText);
  const headerRowIndex = findHeaderRowIndex(rows);

  if (headerRowIndex === -1) {
    return [];
  }

  const headerRow = rows[headerRowIndex];
  const headerIndex = buildHeaderIndex(headerRow);
  const valueHeaderName = findFirstAvailableHeader(headerIndex, SHEET_LOAD_VALUE_HEADERS);

  const checklistCarretaHeader = findFirstAvailableHeader(headerIndex, [
    "checklist carreta1",
    "checklist carreta",
  ]);

  const allRows = [];

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const lh = getCell(row, headerIndex, "lh");

    if (!lh) {
      continue;
    }

    const tipo = getCell(row, headerIndex, "tipo") || null;
    const status = getCell(row, headerIndex, "status");
    const motoristas = getCell(row, headerIndex, "motoristas");
    const origem = getCell(row, headerIndex, "origem");
    const destino = getCell(row, headerIndex, "destino");
    const dataCarregamento = getCell(row, headerIndex, "data carregamento");
    const dataCarregamentoFallback = getCell(row, headerIndex, "data carregamento2");
    const dataDescarga = getCell(row, headerIndex, "data descarga");
    const rawValue = valueHeaderName ? getCell(row, headerIndex, valueHeaderName) : "";

    const cavalo = getCell(row, headerIndex, "cavalo");
    const carreta = getCell(row, headerIndex, "carreta");
    const checklistCavalo = getCell(row, headerIndex, "checklist cavalo");
    const checklistCarreta = checklistCarretaHeader
      ? getCell(row, headerIndex, checklistCarretaHeader)
      : "";

    const rawDateTime = dataCarregamento || dataCarregamentoFallback;

    let data = null;
    let horario = null;
    let carregamentoLabel = null;
    let descargaLabel = null;

    if (rawDateTime) {
      try {
        const parsedDateTime = parseBrazilianDateTime(
          dataCarregamento ? dataCarregamento : `${dataCarregamentoFallback} 00:00:00`,
        );
        data = parsedDateTime.date;
        horario = parsedDateTime.time;
        carregamentoLabel = formatBrazilianDateTimeLabel(parsedDateTime);

        if (dataDescarga) {
          try {
            const parsedUnloadDateTime = parseBrazilianDateTime(dataDescarga);
            descargaLabel = formatBrazilianDateTimeLabel(parsedUnloadDateTime);
          } catch {
            // descarga date unparseable — leave label as null
          }
        }
      } catch {
        // date unparseable — data/horario/labels stay null
      }
    }

    // Disponivel: tem LH (garantido pelo filtro acima), sem motorista, sem status.
    const isAvailable = motoristas === "" && status === "";
    const hasDriver = motoristas !== "";

    // Campos `rawOrigem`/`rawDestino` foram removidos do payload: duplicavam
    // `origem`/`destino` e não são consumidos por nenhum consumidor (Monitor
    // ou Fila). Reduz o tamanho do snapshot persistido e o JSON que o cliente
    // mantém em memória — crítico para manter a RAM baixa em planilhas com
    // milhares de linhas.
    allRows.push({
      lh,
      tipo,
      status,
      motoristas,
      origem: formatSpreadsheetLocation(origem),
      destino: formatSpreadsheetLocation(destino),
      data,
      horario,
      carregamentoLabel,
      descargaLabel,
      valor: valueHeaderName ? parseSpreadsheetCurrency(rawValue) : undefined,
      cavalo,
      carreta,
      checklistCavalo,
      checklistCarreta,
      isAvailable,
      hasDriver,
    });
  }

  // Ordena por data+horario decrescente (mais recentes em cima). Linhas sem
  // data vao para o fim — mantem o operador vendo primeiro as cargas ativas.
  allRows.sort((a, b) => {
    const hasA = Boolean(a.data);
    const hasB = Boolean(b.data);
    if (!hasA && !hasB) return 0;
    if (!hasA) return 1;
    if (!hasB) return -1;
    if (a.data !== b.data) return a.data < b.data ? 1 : -1;
    const horarioA = a.horario || "";
    const horarioB = b.horario || "";
    if (horarioA === horarioB) return 0;
    return horarioA < horarioB ? 1 : -1;
  });

  return allRows;
}

export async function fetchGoogleSheetCsv(fetchImpl, sheetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetchImpl(sheetUrl, {
      headers: {
        Accept: "text/csv; charset=utf-8",
        "Accept-Charset": "utf-8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Google Sheet CSV: ${response.status} ${response.statusText}`);
    }

    // Forçar decodificação UTF-8 — Google Sheets sempre retorna UTF-8, mas
    // proxies/redes podem omitir o charset. arrayBuffer + TextDecoder
    // garante que ã/ç/é não sejam corrompidos por fallback latin1.
    const buffer = await response.arrayBuffer();
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * "A carga (data + horário) ainda está no futuro?" no relógio de São Paulo.
 *
 * Mesma definição de "vencida" usada pelo cron `expire-past-cargas.mjs`
 * (NÃO vencida = `data > hoje` OU `data = hoje E (sem horário OU horário >= agora)`),
 * para que reabrir e expirar nunca discordem e provoquem flapping. Sem `nowSp`
 * ou sem `data`, trata como ativa (não bloqueia a reabertura).
 */
function isSheetLoadActive(load, nowSp) {
  if (!nowSp || !load?.data) {
    return true;
  }

  if (load.data > nowSp.dateIso) {
    return true;
  }

  if (load.data < nowSp.dateIso) {
    return false;
  }

  const loadTime = load.horario || "23:59:59";
  return loadTime >= nowSp.timeIso;
}

function buildSheetLoadPayload({
  load,
  existingLoad,
  routeCatalogDefaultsByKey,
  routeTemplateDefaultsByKey,
  fallbackSheetClientId,
  syncedAt,
  nowSp,
}) {
  const matchedRouteCatalogDefaults = resolveRouteDefaults(routeCatalogDefaultsByKey, load.origem, load.destino);
  const matchedRouteTemplateDefaults = resolveRouteDefaults(routeTemplateDefaultsByKey, load.origem, load.destino);
  const matchedBaseRouteValue = resolveRouteDefaults(BASE_ROUTE_VALUES_BY_KEY, load.origem, load.destino);
  const isExistingLoad = Boolean(existingLoad);

  // Sheet-sourced fields: always updated from the Google Sheet (source of truth for scheduling/routing)
  const sheetFields = {
    id: createSheetLoadId(load.lh),
    sheet_lh: load.lh,
    sheet_tipo: load.tipo,
    sheet_data_carregamento: load.carregamentoLabel,
    sheet_data_descarga: load.descargaLabel,
    sheet_motorista: load.motoristas || null,
    sheet_cavalo: load.cavalo || null,
    sheet_carreta: load.carreta || null,
    data: load.data,
    horario: load.horario,
    origem: load.origem,
    destino: load.destino,
    sheet_synced_at: syncedAt,
  };

  // Operator-editable fields: for NEW cargas, compute from routes/sheet/defaults.
  // For EXISTING cargas, preserve what the operator may have manually edited.
  const operatorFields = isExistingLoad
    ? {
        perfil: existingLoad.perfil || DEFAULT_PROFILE,
        valor: existingLoad.valor,
        bonus: existingLoad.bonus,
        distancia_km: existingLoad.distancia_km,
        duracao_horas: existingLoad.duracao_horas,
        // Planilha sem motorista/status → a carga "fechada" volta ao portal:
        //   BOOKED  → OPEN sempre (operador removeu o motorista da planilha).
        //   EXPIRED → OPEN só se a carga voltou a ser futura (trava de "ativa").
        //     Sem esta porta, uma carga expirada pelo cron — ou pela correção de
        //     uma alocação errada na planilha (motorista adicionado por engano,
        //     depois removido após a data vencer) — ficava presa em EXPIRED:
        //     invisível ao motorista e oculta na visão padrão do operador, mesmo
        //     depois de a planilha voltar a listá-la disponível. A trava de
        //     "ativa" evita reabrir/reexpirar cargas genuinamente vencidas
        //     (flapping → tempestade de eventos realtime/egress).
        //   RESERVED é mantido: um motorista do portal reservou antes do sync.
        status:
          existingLoad.status === "BOOKED" ||
          (existingLoad.status === "EXPIRED" && isSheetLoadActive(load, nowSp))
            ? DEFAULT_PUBLISHED_STATUS
            : existingLoad.status || DEFAULT_PUBLISHED_STATUS,
        is_template: existingLoad.is_template ?? false,
        cliente_id: existingLoad.cliente_id || pickFirstNonEmptyString(fallbackSheetClientId),
        created_by: existingLoad.created_by ?? null,
      }
    : {
        perfil: normalizeVehicleProfile(
          pickFirstNonEmptyString(
            matchedRouteTemplateDefaults?.perfil,
            matchedRouteCatalogDefaults?.perfil,
            DEFAULT_PROFILE,
          ),
          DEFAULT_PROFILE,
        ),
        valor: pickFirstFiniteNumber(
          matchedRouteTemplateDefaults?.valor,
          matchedRouteCatalogDefaults?.valor,
          matchedBaseRouteValue?.valor,
          load.valor,
        ),
        bonus: pickFirstFiniteNumber(
          matchedRouteTemplateDefaults?.bonus,
          matchedRouteCatalogDefaults?.bonus,
        ),
        distancia_km: pickFirstFiniteNumber(
          matchedRouteTemplateDefaults?.distancia_km,
          matchedRouteCatalogDefaults?.distancia_km,
        ),
        duracao_horas: pickFirstFiniteNumber(
          matchedRouteTemplateDefaults?.duracao_horas,
          matchedRouteCatalogDefaults?.duracao_horas,
        ),
        status: DEFAULT_PUBLISHED_STATUS,
        is_template: false,
        cliente_id: pickFirstNonEmptyString(
          fallbackSheetClientId,
          matchedRouteTemplateDefaults?.cliente_id,
        ),
        created_by: null,
      };

  return {
    ...sheetFields,
    ...operatorFields,
  };
}

// Nome do cliente padrão da planilha (ex.: Shopee). Usado pelo Monitor unificado
// para rotular as linhas que vêm da planilha (que é toda de um único cliente).
// [reconstruído após clobber acidental de alteração não-commitada — revisar]
export function getSheetClientName() {
  return DEFAULT_SHEET_CLIENT_NAME;
}

export function buildSheetSummary(allRows) {
  const summary = {
    total: allRows.length,
    available: 0,
    assigned: 0,
    withStatus: 0,
    statuses: {},
    tipos: {},
  };

  for (const row of allRows) {
    if (row.isAvailable) summary.available += 1;
    if (row.hasDriver) summary.assigned += 1;
    if (row.status !== "") summary.withStatus += 1;

    const statusKey = row.status || "Sem status";
    summary.statuses[statusKey] = (summary.statuses[statusKey] || 0) + 1;

    if (row.tipo) {
      summary.tipos[row.tipo] = (summary.tipos[row.tipo] || 0) + 1;
    }
  }

  return summary;
}

export async function updateSheetMonitorSnapshot({ csvText, supabaseClient }) {
  const rows = parseAllGoogleSheetRows(csvText);
  const summary = buildSheetSummary(rows);
  const syncedAt = new Date().toISOString();

  // Persist to DB so future reads are instant.
  // Non-fatal in terms of user experience (rows are still returned), but the
  // caller MUST be able to tell if the save succeeded so it can surface a
  // clear error — otherwise the screen shows data now but "Nenhum dado
  // carregado ainda" on the next reload.
  const { data, error } = await supabaseClient
    .from("sheet_monitor_snapshot")
    .upsert(
      { id: 1, rows_json: rows, summary_json: summary, synced_at: syncedAt },
      { onConflict: "id" },
    )
    .select("id, synced_at")
    .maybeSingle();

  if (error) {
    console.error("[sheet-monitor-snapshot] failed to upsert snapshot", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
    });
    return {
      rows,
      summary,
      syncedAt,
      persisted: false,
      persistError: {
        code: error?.code ?? null,
        message: error?.message ?? "Erro desconhecido ao salvar snapshot",
        hint: error?.hint ?? null,
      },
    };
  }

  return {
    rows,
    summary,
    syncedAt: data?.synced_at ?? syncedAt,
    persisted: true,
    persistError: null,
  };
}

export async function syncGoogleSheetLoads({
  fetchImpl = globalThis.fetch,
  sheetUrl = getSheetExportUrl(),
  supabaseClient = createSupabaseAdminClient(),
  sheetClientId,
  /**
   * Sobrescreve o nome do cliente buscado em `public.clientes.nome`. Por
   * default cai no env `GOOGLE_SHEET_DEFAULT_CLIENT_NAME` (ou "Shopee").
   * Útil em testes e em pipelines com múltiplos sheets.
   */
  clientName,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  if (!sheetUrl) {
    console.warn("[google-sheet-loads] GOOGLE_SHEET_ID nao configurado. Sincronizacao de planilha ignorada.");
    return {
      skipped: true,
      reason: "GOOGLE_SHEET_ID_NOT_CONFIGURED",
      inserted: 0,
      updated: 0,
      deleted: 0,
    };
  }

  const csvText = await fetchGoogleSheetCsv(fetchImpl, sheetUrl);
  const invalidRows = [];
  const availableLoads = parseAvailableGoogleSheetLoads(csvText, {
    onInvalidRow: (row) => invalidRows.push(row),
  });
  const syncedAt = new Date().toISOString();
  // "Agora" no relógio de São Paulo (carga.data/horario são horário do Brasil) — usado
  // p/ reabrir (EXPIRED→OPEN) só as cargas que voltaram a ser futuras na planilha.
  const nowSp = getSaoPauloWallClock();

  if (invalidRows.length > 0) {
    console.warn("[google-sheet-loads] skipped rows with invalid datetime", {
      count: invalidRows.length,
      rows: invalidRows.slice(0, 10),
    });
  }

  const fallbackSheetClientId =
    typeof sheetClientId === "string" && sheetClientId.trim() !== ""
      ? sheetClientId.trim()
      : await resolveSheetClientId(
          supabaseClient,
          clientName ?? DEFAULT_SHEET_CLIENT_NAME,
        );
  const existingSheetLoads = await fetchExistingSheetLoads(supabaseClient);
  const routeCatalogRows = await fetchRouteCatalogRows(supabaseClient);
  const routeTemplateRows = await fetchRouteTemplateRows(supabaseClient);
  const existingLoadsBySheetLh = new Map(
    existingSheetLoads
      .filter((load) => typeof load.sheet_lh === "string" && load.sheet_lh.trim() !== "")
      .map((load) => [load.sheet_lh, load]),
  );
  const routeCatalogDefaultsByKey = createRouteCatalogDefaultsMap(routeCatalogRows);
  const routeTemplateDefaultsByKey = createRouteTemplateDefaultsMap(routeTemplateRows);
  let revertedToOpenCount = 0;
  let revivedExpiredCount = 0;
  const sheetLoadPayloads = availableLoads.map((load) => {
    const existingLoad = existingLoadsBySheetLh.get(load.lh);
    const payload = buildSheetLoadPayload({
      load,
      existingLoad,
      routeCatalogDefaultsByKey,
      routeTemplateDefaultsByKey,
      fallbackSheetClientId,
      syncedAt,
      nowSp,
    });
    // Contadores separados (observabilidade): BOOKED→OPEN vs EXPIRED→OPEN.
    if (existingLoad?.status === "BOOKED" && payload.status === DEFAULT_PUBLISHED_STATUS) {
      revertedToOpenCount += 1;
    }
    if (existingLoad?.status === "EXPIRED" && payload.status === DEFAULT_PUBLISHED_STATUS) {
      revivedExpiredCount += 1;
    }
    return payload;
  });

  if (sheetLoadPayloads.length > 0) {
    const { error: upsertError } = await supabaseClient
      .from(SHEET_LOADS_TABLE)
      .upsert(sheetLoadPayloads, {
        onConflict: "id",
      });

    if (upsertError) {
      throw upsertError;
    }
  }

  const currentSheetKeys = new Set(sheetLoadPayloads.map((load) => load.sheet_lh));

  // Parse ALL rows (including non-available) to differentiate two kinds of stale loads:
  // - staleInSheet: operator assigned driver/status → row still exists in sheet, preserve sheet_lh
  //   so Histórico can look up the live sheet status via sheetLh.
  // - staleTrulyGone: row was completely removed → clear sheet_lh, EXPIRED (OPEN only).
  const allSheetRows = parseAllGoogleSheetRows(csvText);
  const allSheetRowsByLh = new Map(
    allSheetRows.filter((r) => r.lh && r.lh.trim()).map((r) => [r.lh.trim(), r]),
  );

  const staleInSheet = [];   // still present in sheet (closed by operator)
  const staleTrulyGone = []; // completely removed from sheet

  for (const existingLoad of existingSheetLoads || []) {
    if (!existingLoad.sheet_lh?.trim()) continue;
    if (currentSheetKeys.has(existingLoad.sheet_lh)) continue;

    // RESERVED é INTOCÁVEL pelo sync: uma reserva do portal (lead APPROVED +
    // reserved_public_lead_id) só se resolve pelo ciclo de reserva (cancelar /
    // confirmar). Se a planilha "fechasse" a linha (motorista preenchido) ou a
    // removesse e o sync flipasse RESERVED→BOOKED, o cancelamento da reserva —
    // que só reabre a carga para OPEN quando o status ainda é 'RESERVED' — parava
    // de funcionar e a carga ficava presa em BOOKED, impossível de reabrir
    // (MANUAL_CARGO_STATUSES = {DRAFT, OPEN}). Era o bug "trocar o motorista de uma
    // carga reservada fazia a carga sumir e não dava pra voltar a aberta".
    // O caminho de cargas disponíveis já preserva RESERVED; aqui fechamos a lacuna.
    if (existingLoad.status === "RESERVED") continue;

    const sheetRow = allSheetRowsByLh.get(existingLoad.sheet_lh.trim());
    if (sheetRow) {
      staleInSheet.push({
        id: existingLoad.id,
        motorista: sheetRow.motoristas?.trim() || null,
        cavalo: sheetRow.cavalo?.trim() || null,
        carreta: sheetRow.carreta?.trim() || null,
        tipo: sheetRow.tipo?.trim() || null,
        dataCarregamento: sheetRow.carregamentoLabel || null,
        dataDescarga: sheetRow.descargaLabel || null,
        sheetStatus: sheetRow.status?.trim() || null,
      });
    } else {
      staleTrulyGone.push(existingLoad.id);
    }
  }

  // Cargas fechadas pelo operador na planilha (motorista ou status preenchido):
  // preserva sheet_lh para que o Histórico busque o status ao vivo pelo LH.
  if (staleInSheet.length > 0) {
    await withPgClient(async (pgClient) => {
      await pgClient.query(
        `
          UPDATE public.cargas c
          SET
            sheet_motorista         = v.motorista,
            sheet_cavalo            = v.cavalo,
            sheet_carreta           = v.carreta,
            sheet_tipo              = v.tipo,
            sheet_data_carregamento = v.data_carregamento,
            sheet_data_descarga     = v.data_descarga,
            sheet_status            = v.sheet_status,
            sheet_synced_at         = $1,
            -- Só OPEN→BOOKED. RESERVED é preservado (já filtrado acima; o guard
            -- aqui é defesa em profundidade contra corrida entre leitura e write).
            status = CASE WHEN c.status = 'OPEN' THEN 'BOOKED' ELSE c.status END
          FROM (
            SELECT
              UNNEST($2::uuid[])  AS id,
              UNNEST($3::text[])  AS motorista,
              UNNEST($4::text[])  AS cavalo,
              UNNEST($5::text[])  AS carreta,
              UNNEST($6::text[])  AS tipo,
              UNNEST($7::text[])  AS data_carregamento,
              UNNEST($8::text[])  AS data_descarga,
              UNNEST($9::text[])  AS sheet_status
          ) AS v
          WHERE c.id = v.id
            -- Anti no-op: só reescreve quando algo MUDOU (ou ainda precisa
            -- transitar OPEN/RESERVED→BOOKED). Sem este guard, todo sync
            -- reescrevia todas as cargas booked com valores idênticos, gerando
            -- dead tuples (bloat de cargas) e uma tempestade de eventos realtime
            -- no canal cargas — amplificador do incidente de 70GB de egress do
            -- pooler. O indicador global de ultimo sync (sheet_synced_at)
            -- segue fresco via o upsert das cargas disponíveis, não daqui.
            AND (
              c.status = 'OPEN'
              OR c.sheet_motorista         IS DISTINCT FROM v.motorista
              OR c.sheet_cavalo            IS DISTINCT FROM v.cavalo
              OR c.sheet_carreta           IS DISTINCT FROM v.carreta
              OR c.sheet_tipo              IS DISTINCT FROM v.tipo
              OR c.sheet_data_carregamento IS DISTINCT FROM v.data_carregamento
              OR c.sheet_data_descarga     IS DISTINCT FROM v.data_descarga
              OR c.sheet_status            IS DISTINCT FROM v.sheet_status
            )
        `,
        [
          syncedAt,
          staleInSheet.map((s) => s.id),
          staleInSheet.map((s) => s.motorista),
          staleInSheet.map((s) => s.cavalo),
          staleInSheet.map((s) => s.carreta),
          staleInSheet.map((s) => s.tipo),
          staleInSheet.map((s) => s.dataCarregamento),
          staleInSheet.map((s) => s.dataDescarga),
          staleInSheet.map((s) => s.sheetStatus),
        ],
      );
    });

    console.info(
      `[google-sheet-loads] ${staleInSheet.length} cargas fechadas pela planilha (OPEN→BOOKED, RESERVED preservado, sheet_lh preservado)`,
      { count: staleInSheet.length },
    );
  }

  // Cargas completamente removidas da planilha: expira OPEN. Cargas RESERVED já
  // foram filtradas do batch acima (intocáveis pelo sync — a reserva manda).
  if (staleTrulyGone.length > 0) {
    await withPgClient(async (pgClient) => {
      await pgClient.query(
        `
          UPDATE public.cargas
          SET
            sheet_tipo = NULL,
            sheet_data_carregamento = CASE WHEN status = 'OPEN' THEN NULL ELSE sheet_data_carregamento END,
            sheet_data_descarga    = CASE WHEN status = 'OPEN' THEN NULL ELSE sheet_data_descarga END,
            sheet_motorista        = CASE WHEN status = 'OPEN' THEN NULL ELSE sheet_motorista END,
            sheet_cavalo           = CASE WHEN status = 'OPEN' THEN NULL ELSE sheet_cavalo END,
            sheet_carreta          = CASE WHEN status = 'OPEN' THEN NULL ELSE sheet_carreta END,
            sheet_synced_at = NULL,
            status = CASE WHEN status = 'OPEN' THEN 'EXPIRED' ELSE status END
          WHERE id = ANY($1::uuid[])
        `,
        [staleTrulyGone],
      );
    });

    console.info(
      `[google-sheet-loads] ${staleTrulyGone.length} cargas removidas da planilha (OPEN→EXPIRED, RESERVED preservado)`,
      { count: staleTrulyGone.length },
    );
  }

  // Persist a full snapshot (all rows + summary) so the Sheet Monitor
  // screen can read from the DB instead of fetching Google Sheets each time.
  try {
    await updateSheetMonitorSnapshot({ csvText, supabaseClient });
  } catch (snapshotError) {
    // Non-fatal — the sync itself succeeded; log and continue.
    console.error("[sheet-monitor-snapshot] snapshot update failed after sync", {
      name: snapshotError?.name,
      code: snapshotError?.code,
      message: snapshotError?.message,
    });
  }

  if (revertedToOpenCount > 0) {
    console.info(
      `[google-sheet-loads] ${revertedToOpenCount} cargas BOOKED revertidas para OPEN (motorista removido da planilha)`,
      { count: revertedToOpenCount },
    );
  }

  if (revivedExpiredCount > 0) {
    console.info(
      `[google-sheet-loads] ${revivedExpiredCount} cargas EXPIRED reabertas para OPEN (planilha voltou a listar a carga como disponível e futura)`,
      { count: revivedExpiredCount },
    );
  }

  // Cancelamento vindo da planilha: linhas que ficaram CANCELADO no sync e ainda
  // têm motorista → cascata da rota (Interpretação A), idempotente. Non-fatal: o
  // sync já concluiu. Import dinâmico evita ciclo (cancel-load-cascade → este módulo).
  let cancelCascadeSwept = 0;
  try {
    const { sweepCancelledCascades } = await import("../operator-admin/sweep-cancelled-cascades.js");
    const swept = await sweepCancelledCascades({});
    cancelCascadeSwept = swept.cascaded;
    if (swept.cascaded > 0) {
      console.info(`[google-sheet-loads] ${swept.cascaded} cancelamento(s) da planilha cascateado(s) na fila`, { ...swept });
    }
  } catch (sweepError) {
    console.error("[google-sheet-loads] sweep de cancelamento falhou após sync", {
      message: sweepError instanceof Error ? sweepError.message : String(sweepError),
    });
  }

  return {
    availableLoadsCount: sheetLoadPayloads.length,
    unlinkedLoadsCount: staleInSheet.length + staleTrulyGone.length,
    revertedToOpenCount,
    revivedExpiredCount,
    skippedInvalidLoadsCount: invalidRows.length,
    cancelCascadeSwept,
    sheetUrl,
  };
}
