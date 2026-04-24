import crypto from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import "../../infrastructure/config/load-env.js";
import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { normalizeVehicleProfile } from "../../domain/vehicle-profiles.js";
import { baseRouteValues as BASE_ROUTE_VALUES } from "../../domain/operator-admin/base-route-values.js";

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

function parseCsv(text) {
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

export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl) {
    throw new Error("Missing required environment variable: SUPABASE_URL");
  }

  if (!serviceRoleKey) {
    throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function resolveSheetClientId(supabaseClient, clientName = DEFAULT_SHEET_CLIENT_NAME) {
  const trimmedClientName = clientName.trim();

  if (!trimmedClientName) {
    throw new Error("Missing required sheet client name.");
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
    throw new Error(`Missing required sheet client record: ${trimmedClientName}`);
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
        Accept: "text/csv",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Google Sheet CSV: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function buildSheetLoadPayload({
  load,
  existingLoad,
  routeCatalogDefaultsByKey,
  routeTemplateDefaultsByKey,
  fallbackSheetClientId,
  syncedAt,
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
        status: existingLoad.status || DEFAULT_PUBLISHED_STATUS,
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

  if (invalidRows.length > 0) {
    console.warn("[google-sheet-loads] skipped rows with invalid datetime", {
      count: invalidRows.length,
      rows: invalidRows.slice(0, 10),
    });
  }

  const fallbackSheetClientId =
    typeof sheetClientId === "string" && sheetClientId.trim() !== ""
      ? sheetClientId.trim()
      : await resolveSheetClientId(supabaseClient);
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
  const sheetLoadPayloads = availableLoads.map((load) =>
    buildSheetLoadPayload({
      load,
      existingLoad: existingLoadsBySheetLh.get(load.lh),
      routeCatalogDefaultsByKey,
      routeTemplateDefaultsByKey,
      fallbackSheetClientId,
      syncedAt,
    }),
  );

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
  const staleSheetLoadIds = (existingSheetLoads || [])
    .filter((load) => load.sheet_lh && load.sheet_lh.trim() !== "" && !currentSheetKeys.has(load.sheet_lh))
    .map((load) => load.id);

  // Instead of deleting stale cargas (which would CASCADE DELETE associated leads),
  // unlink them from the sheet by clearing sheet_lh. The cargo and all its
  // associated data (leads, claims, events) are preserved as manual cargas.
  // Also expire OPEN cargas so they stop appearing to drivers — the spreadsheet
  // is the source of truth for availability.
  // Single raw pg UPDATE for atomicity — avoids partial-unlink state from batch loops.
  if (staleSheetLoadIds.length > 0) {
    await withPgClient(async (pgClient) => {
      await pgClient.query(
        `
          UPDATE public.cargas
          SET
            sheet_lh = NULL,
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
        [staleSheetLoadIds],
      );
    });

    console.info(`[google-sheet-loads] unlinked ${staleSheetLoadIds.length} stale cargas from sheet (expired OPEN ones, preserved data)`, {
      count: staleSheetLoadIds.length,
    });
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

  return {
    availableLoadsCount: sheetLoadPayloads.length,
    unlinkedLoadsCount: staleSheetLoadIds.length,
    skippedInvalidLoadsCount: invalidRows.length,
    sheetUrl,
  };
}
