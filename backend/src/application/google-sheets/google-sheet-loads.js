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
// `tipo` NÃO é obrigatório: nem toda planilha tem coluna de tipo de carga (a
// Nestlé não tem — só VINCULO). Deixar `tipo` fora da lista de obrigatórios
// permite que essas fontes resolvam o cabeçalho sem precisar "emprestar" outra
// coluna (o que antes fazia o vínculo vazar para o campo tipo).
const SHEET_LOADS_REQUIRED_HEADERS = [
  "lh",
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

// ── Multi-sheet support ─────────────────────────────────────────────────────
//
// O sync agora puxa cargas de MÚLTIPLAS planilhas (Shopee + Nestlé) sem que uma
// fonte expire/limpe as cargas da outra. Cada fonte tem:
//   - source: discriminador persistido em cargas.sheet_source
//   - clientName: linha esperada em public.clientes.nome (rótulo do Monitor)
//   - sheetUrl: CSV export da planilha
//   - headerSchema: mapeamento CANÔNICO → [nomes de coluna candidatos].
//     O parser resolve cada coluna canônica pelo primeiro candidato presente na
//     linha de cabeçalho (via normalizeHeaderName). A Shopee usa o schema
//     identidade (cada canônico → [ele mesmo]) → comportamento IDÊNTICO ao atual.
//
// A regra de "disponível" é a mesma para todas as fontes: STATUS em branco +
// MOTORISTA em branco → OPEN → aparece no portal/monitor.

// Colunas canônicas exigidas de QUALQUER fonte (o header row precisa resolver
// todas). Deriva de SHEET_LOADS_REQUIRED_HEADERS para não divergir.
const CANONICAL_REQUIRED_COLUMNS = SHEET_LOADS_REQUIRED_HEADERS;

// Schema da Shopee: identidade — cada coluna canônica mapeia para o próprio
// nome. Preserva 100% do comportamento pré-multi-sheet.
const SHOPEE_HEADER_SCHEMA = {
  lh: ["lh"],
  tipo: ["tipo"],
  "data carregamento": ["data carregamento"],
  "data descarga": ["data descarga"],
  motoristas: ["motoristas"],
  origem: ["origem"],
  destino: ["destino"],
  status: ["status"],
  valor: SHEET_LOAD_VALUE_HEADERS,
};

// Schema da Nestlé: os cabeçalhos reais da planilha (NÃO renomeada) mapeados via
// aliases. CHEGADA PREVISTA → data carregamento; DESCARGA → data descarga.
export const NESTLE_HEADER_SCHEMA = {
  lh: ["lh", "nº de ordem", "n de ordem", "no de ordem"],
  // A Nestlé NÃO tem coluna de tipo de carga (só VINCULO — FROTA/AGREGADO/
  // TERCEIRO, que é o vínculo do motorista). Antes o alias caía em "vinculo" e
  // o vínculo vazava para o campo `tipo`, poluindo o filtro de Tipo do Monitor.
  // Sem coluna "tipo" → tipo fica null; o vínculo é lido separadamente.
  tipo: ["tipo"],
  "data carregamento": ["data carregamento", "chegada prevista"],
  "data descarga": ["data descarga", "descarga"],
  motoristas: ["motoristas", "motorista"],
  origem: ["origem"],
  destino: ["destino"],
  status: ["status"],
  valor: SHEET_LOAD_VALUE_HEADERS,
};

const SHEET_SOURCE_SHOPEE = "shopee";
const SHEET_SOURCE_NESTLE = "nestle";

const NESTLE_DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1VdESScwEtkxFuCIqPpganwEOVTOOXu1ZR3MiKUjRUS8/export?format=csv&gid=0";
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
  // Aceita sufixo de UF por barra ("/SP") OU hífen ("-SP", " - PE"). A planilha
  // Nestlé usa hífen; sem isso o sync não casava as cargas com as rotas do catálogo.
  return value.replace(/\s*[-/]\s*[a-z]{2}$/i, "").trim();
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

  // "Jaboatão" isolado no cadastro do operador (route_metrics_cache) representa
  // a mesma cidade que "Jaboatão dos Guararapes" vindo da planilha do cliente.
  // Sem esse alias, o match falhava e o sync caía no fallback hardcodado de
  // BASE_ROUTE_VALUES, ignorando o preço configurado pelo operador.
  if (/\bjaboatao\b/.test(normalizedValue)) {
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

  // Aliases de nome divergente entre a planilha do cliente e o cadastro de rota.
  // Cabo de Santo Agostinho — planilha Nestlé abrevia "STO", cadastro usa "SANTO".
  if (/\b(?:sto|santo) agostinho\b/.test(normalizedValue)) {
    return "cabo de santo agostinho";
  }

  // Nossa Senhora do Socorro/SE — cadastro abrevia "Nª SRA. DO SOCORRO".
  if (/\bsocorro\b/.test(normalizedValue)) {
    return "nossa senhora do socorro";
  }

  // São Bernardo do Campo — planilha "DO CAMPO", cadastro "DOS CAMPOS".
  if (/\bsao bernardo d/.test(normalizedValue)) {
    return "sao bernardo do campo";
  }

  // Maceió — a rota do catálogo traz sufixo "/AL - N EIXOS" que sobra no canônico.
  if (/\bmaceio\b/.test(normalizedValue)) {
    return "maceio";
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

export function createSheetLoadId(sheetLh, source) {
  // ID namespacing por fonte. A Shopee (fonte histórica) mantém o namespace
  // ORIGINAL `sheet-load:${lh}` para não invalidar os UUIDs já persistidos em
  // produção. Outras fontes ganham um namespace próprio `sheet-load:${source}:${lh}`,
  // impedindo colisão de UUID quando duas planilhas usam o mesmo LH.
  const namespace =
    !source || source === SHEET_SOURCE_SHOPEE
      ? `sheet-load:${sheetLh}`
      : `sheet-load:${source}:${sheetLh}`;
  const hash = crypto.createHash("sha1").update(namespace).digest("hex");
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

// Uma linha é o cabeçalho quando TODAS as colunas canônicas exigidas resolvem
// para algum candidato do schema presente naquela linha. Com o SHOPEE_HEADER_SCHEMA
// (identidade) isto é exatamente o comportamento anterior (`.has(header)` para
// cada header exigido).
function findHeaderRowIndex(rows, headerSchema = SHOPEE_HEADER_SCHEMA) {
  return rows.findIndex((row) => {
    const normalizedHeaders = new Set(row.map((cell) => normalizeHeaderName(cell)));

    return CANONICAL_REQUIRED_COLUMNS.every((canonical) => {
      const candidates = headerSchema[canonical] || [canonical];
      return candidates.some((candidate) => normalizedHeaders.has(normalizeHeaderName(candidate)));
    });
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

// Resolve cada coluna canônica do schema para o nome de cabeçalho concreto
// presente na planilha (ou null se ausente). Reusa findFirstAvailableHeader para
// achar o primeiro candidato do schema que existe no headerIndex. Consumido
// pelos parsers para ler as células via getCell(row, headerIndex, resolvedName).
function resolveSchemaColumns(headerIndex, headerSchema = SHOPEE_HEADER_SCHEMA) {
  const resolved = {};

  for (const [canonical, candidates] of Object.entries(headerSchema)) {
    resolved[canonical] = findFirstAvailableHeader(headerIndex, candidates);
  }

  return resolved;
}

function chunkArray(values, chunkSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

async function fetchExistingSheetLoads(supabaseClient, source = SHEET_SOURCE_SHOPEE) {
  const existingLoads = [];

  for (let offset = 0; ; offset += EXISTING_SHEET_LOADS_PAGE_SIZE) {
    const { data, error } = await supabaseClient
      .from(SHEET_LOADS_TABLE)
      .select("id, sheet_lh, valor, bonus, cliente_id, perfil, distancia_km, duracao_horas, status, is_template, created_by")
      .not("sheet_lh", "is", null)
      // Só cargas que vieram do sync da planilha (sheet_synced_at preenchido).
      // Cargas importadas manualmente têm sheet_lh mas sheet_synced_at NULL —
      // não pertencem a nenhuma planilha e NÃO devem ser expiradas pelo sync.
      .not("sheet_synced_at", "is", null)
      // Escopo por FONTE: um sync da Nestlé só enxerga (e portanto só expira/limpa)
      // cargas da Nestlé; nunca toca cargas da Shopee, e vice-versa. Sem este
      // filtro, o sync de uma fonte expiraria todas as cargas da outra (que não
      // aparecem no CSV dela) — o bug de contaminação cross-sheet.
      .eq("sheet_source", source)
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
  const { onInvalidRow, headerSchema = SHOPEE_HEADER_SCHEMA } = options;
  const rows = parseCsv(csvText);
  const headerRowIndex = findHeaderRowIndex(rows, headerSchema);

  if (headerRowIndex === -1) {
    const foundHeaders = rows.length > 0
      ? [...new Set(rows.slice(0, 5).flatMap((row) => row.map((cell) => normalizeHeaderName(cell)).filter(Boolean)))]
      : [];
    const missingHeaders = CANONICAL_REQUIRED_COLUMNS.filter((canonical) => {
      const candidates = headerSchema[canonical] || [canonical];
      return !candidates.some((candidate) => foundHeaders.includes(normalizeHeaderName(candidate)));
    });
    throw new Error(
      `Unable to find the Google Sheet header row. Missing required headers: [${missingHeaders.join(", ")}]. Found in first rows: [${foundHeaders.slice(0, 15).join(", ")}].`,
    );
  }

  const headerRow = rows[headerRowIndex];
  const headerIndex = buildHeaderIndex(headerRow);
  const columns = resolveSchemaColumns(headerIndex, headerSchema);
  const valueHeaderName = columns.valor;
  const availableLoads = [];

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const lh = columns.lh ? getCell(row, headerIndex, columns.lh) : "";
    const tipo = columns.tipo ? getCell(row, headerIndex, columns.tipo) : "";
    const dataCarregamento = columns["data carregamento"]
      ? getCell(row, headerIndex, columns["data carregamento"])
      : "";
    // Fallback "data carregamento2" (só no schema Shopee) — coluna auxiliar de
    // data sem hora. Não faz parte dos schemas de aliases; buscada direto.
    const dataCarregamentoFallback = getCell(row, headerIndex, "data carregamento2");
    const dataDescarga = columns["data descarga"]
      ? getCell(row, headerIndex, columns["data descarga"])
      : "";
    const motoristas = columns.motoristas ? getCell(row, headerIndex, columns.motoristas) : "";
    const origem = columns.origem ? getCell(row, headerIndex, columns.origem) : "";
    const destino = columns.destino ? getCell(row, headerIndex, columns.destino) : "";
    const status = columns.status ? getCell(row, headerIndex, columns.status) : "";
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

export function parseAllGoogleSheetRows(csvText, options = {}) {
  const { headerSchema = SHOPEE_HEADER_SCHEMA } = options;
  const rows = parseCsv(csvText);
  const headerRowIndex = findHeaderRowIndex(rows, headerSchema);

  if (headerRowIndex === -1) {
    return [];
  }

  const headerRow = rows[headerRowIndex];
  const headerIndex = buildHeaderIndex(headerRow);
  const columns = resolveSchemaColumns(headerIndex, headerSchema);
  const valueHeaderName = columns.valor;

  const checklistCarretaHeader = findFirstAvailableHeader(headerIndex, [
    "checklist carreta1",
    "checklist carreta",
  ]);

  const allRows = [];

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const lh = columns.lh ? getCell(row, headerIndex, columns.lh) : "";

    if (!lh) {
      continue;
    }

    const tipo = (columns.tipo ? getCell(row, headerIndex, columns.tipo) : "") || null;
    const status = columns.status ? getCell(row, headerIndex, columns.status) : "";
    const motoristas = columns.motoristas ? getCell(row, headerIndex, columns.motoristas) : "";
    const origem = columns.origem ? getCell(row, headerIndex, columns.origem) : "";
    const destino = columns.destino ? getCell(row, headerIndex, columns.destino) : "";
    const dataCarregamento = columns["data carregamento"]
      ? getCell(row, headerIndex, columns["data carregamento"])
      : "";
    const dataCarregamentoFallback = getCell(row, headerIndex, "data carregamento2");
    const dataDescarga = columns["data descarga"]
      ? getCell(row, headerIndex, columns["data descarga"])
      : "";
    const rawValue = valueHeaderName ? getCell(row, headerIndex, valueHeaderName) : "";

    const cavalo = getCell(row, headerIndex, "cavalo");
    const carreta = getCell(row, headerIndex, "carreta");
    const vinculo = getCell(row, headerIndex, "vinculo");
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
      vinculo,
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
  source = SHEET_SOURCE_SHOPEE,
}) {
  const matchedRouteCatalogDefaults = resolveRouteDefaults(routeCatalogDefaultsByKey, load.origem, load.destino);
  const matchedRouteTemplateDefaults = resolveRouteDefaults(routeTemplateDefaultsByKey, load.origem, load.destino);
  const matchedBaseRouteValue = resolveRouteDefaults(BASE_ROUTE_VALUES_BY_KEY, load.origem, load.destino);
  const isExistingLoad = Boolean(existingLoad);

  // Sheet-sourced fields: always updated from the Google Sheet (source of truth for scheduling/routing)
  const sheetFields = {
    id: createSheetLoadId(load.lh, source),
    sheet_lh: load.lh,
    sheet_source: source,
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

// "Puxar tudo" (fontes com pullAllRows, ex.: Nestlé): monta a carga de uma linha
// JÁ ALOCADA na planilha (motorista/status preenchidos) que ainda NÃO existe no
// sistema. Nasce BOOKED, com os campos sheet_* de alocação preenchidos e o
// valor/perfil resolvidos do catálogo de rotas (a planilha do cliente não traz
// valor). Espelha a planilha inteira em /cargas — não só as disponíveis.
function buildAllocatedSheetLoadPayload({
  row,
  routeCatalogDefaultsByKey,
  routeTemplateDefaultsByKey,
  fallbackSheetClientId,
  syncedAt,
  source,
}) {
  const matchedRouteCatalogDefaults = resolveRouteDefaults(routeCatalogDefaultsByKey, row.origem, row.destino);
  const matchedRouteTemplateDefaults = resolveRouteDefaults(routeTemplateDefaultsByKey, row.origem, row.destino);
  const matchedBaseRouteValue = resolveRouteDefaults(BASE_ROUTE_VALUES_BY_KEY, row.origem, row.destino);

  return {
    id: createSheetLoadId(row.lh, source),
    sheet_lh: row.lh,
    sheet_source: source,
    sheet_tipo: row.tipo,
    sheet_data_carregamento: row.carregamentoLabel,
    sheet_data_descarga: row.descargaLabel,
    sheet_motorista: row.motoristas || null,
    sheet_cavalo: row.cavalo || null,
    sheet_carreta: row.carreta || null,
    sheet_status: row.status || null,
    data: row.data,
    horario: row.horario,
    origem: row.origem,
    destino: row.destino,
    sheet_synced_at: syncedAt,
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
      row.valor,
    ),
    bonus: pickFirstFiniteNumber(matchedRouteTemplateDefaults?.bonus, matchedRouteCatalogDefaults?.bonus),
    distancia_km: pickFirstFiniteNumber(
      matchedRouteTemplateDefaults?.distancia_km,
      matchedRouteCatalogDefaults?.distancia_km,
    ),
    duracao_horas: pickFirstFiniteNumber(
      matchedRouteTemplateDefaults?.duracao_horas,
      matchedRouteCatalogDefaults?.duracao_horas,
    ),
    status: "BOOKED",
    is_template: false,
    cliente_id: pickFirstNonEmptyString(fallbackSheetClientId, matchedRouteTemplateDefaults?.cliente_id),
    created_by: null,
  };
}

// Nome do cliente padrão da planilha (ex.: Shopee). Usado pelo Monitor unificado
// para rotular as linhas que vêm da planilha (que é toda de um único cliente).
// [reconstruído após clobber acidental de alteração não-commitada — revisar]
export function getSheetClientName() {
  return DEFAULT_SHEET_CLIENT_NAME;
}

// id determinístico do snapshot por fonte. A Shopee mantém o id=1 histórico
// (byte-compatível com a linha singleton atual). Fontes novas usam ids fixos
// distintos — o índice UNIQUE(source) é a chave real de upsert (onConflict).
const SNAPSHOT_ID_BY_SOURCE = {
  [SHEET_SOURCE_SHOPEE]: 1,
  [SHEET_SOURCE_NESTLE]: 2,
};

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

export async function updateSheetMonitorSnapshot({
  csvText,
  supabaseClient,
  // Fonte do snapshot. Default 'shopee' → comportamento e payload IDÊNTICOS ao
  // atual (id=1, onConflict:'id', sem coluna source no payload), garantindo que
  // a linha da Shopee continue byte-compatível.
  source = SHEET_SOURCE_SHOPEE,
  headerSchema = SHOPEE_HEADER_SCHEMA,
  // Rótulo do cliente da fonte — embutido no summary_json (não há coluna dedicada)
  // para o Monitor rotular cada fonte. Só é gravado em fontes != shopee, mantendo
  // o summary_json da Shopee inalterado.
  clientName,
} = {}) {
  const rows = parseAllGoogleSheetRows(csvText, { headerSchema });
  const summary = buildSheetSummary(rows);
  const syncedAt = new Date().toISOString();

  const isShopee = !source || source === SHEET_SOURCE_SHOPEE;

  // Persist to DB so future reads are instant.
  // Non-fatal in terms of user experience (rows are still returned), but the
  // caller MUST be able to tell if the save succeeded so it can surface a
  // clear error — otherwise the screen shows data now but "Nenhum dado
  // carregado ainda" on the next reload.
  //
  // Snapshot per-source: cada fonte grava a PRÓPRIA linha (chave = coluna
  // `source`, UNIQUE). A Shopee mantém id=1 + onConflict:'id' + payload sem
  // `source` — exatamente como antes, sem clobber ao rodar a Nestlé. Fontes
  // novas usam id determinístico (SNAPSHOT_ID_BY_SOURCE) + onConflict:'source'
  // e carregam clientName dentro do summary_json.
  const snapshotRow = isShopee
    ? { id: 1, rows_json: rows, summary_json: summary, synced_at: syncedAt }
    : {
        id: SNAPSHOT_ID_BY_SOURCE[source] ?? undefined,
        source,
        rows_json: rows,
        summary_json: clientName ? { ...summary, clientName } : summary,
        synced_at: syncedAt,
      };

  const { data, error } = await supabaseClient
    .from("sheet_monitor_snapshot")
    .upsert(snapshotRow, { onConflict: isShopee ? "id" : "source" })
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
  /**
   * Fonte da planilha. Default 'shopee' (back-compat total: ids, escopo de
   * limpeza e snapshot idênticos ao comportamento anterior). Fontes novas
   * (ex.: 'nestle') isolam suas cargas via cargas.sheet_source.
   */
  source = SHEET_SOURCE_SHOPEE,
  /**
   * Mapeamento canônico → candidatos de cabeçalho da fonte. Default = SHOPEE
   * (identidade). A Nestlé passa NESTLE_HEADER_SCHEMA (aliases).
   */
  headerSchema = SHOPEE_HEADER_SCHEMA,
  /**
   * "Puxar tudo da planilha": quando true, além das disponíveis (→ OPEN), o sync
   * também IMPORTA as linhas já alocadas (motorista/status) como cargas BOOKED —
   * espelhando a planilha inteira em /cargas. Default false (Shopee inalterado:
   * só disponíveis viram carga; alocadas só entram via ciclo OPEN→BOOKED).
   */
  pullAllRows = false,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  if (!sheetUrl) {
    console.warn("[google-sheet-loads] GOOGLE_SHEET_ID nao configurado. Sincronizacao de planilha ignorada.");
    return {
      skipped: true,
      reason: "GOOGLE_SHEET_ID_NOT_CONFIGURED",
      source,
      inserted: 0,
      updated: 0,
      deleted: 0,
    };
  }

  const csvText = await fetchGoogleSheetCsv(fetchImpl, sheetUrl);
  const invalidRows = [];
  const availableLoads = parseAvailableGoogleSheetLoads(csvText, {
    onInvalidRow: (row) => invalidRows.push(row),
    headerSchema,
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
  const existingSheetLoads = await fetchExistingSheetLoads(supabaseClient, source);
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
      source,
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
  const allSheetRows = parseAllGoogleSheetRows(csvText, { headerSchema });
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
            -- Escopo por FONTE: um sync da Nestlé só fecha cargas da Nestlé.
            -- Os ids já vêm escopados (fetchExistingSheetLoads filtra por
            -- sheet_source), mas repetir o filtro aqui é defesa em profundidade
            -- contra a contaminação cross-sheet.
            AND c.sheet_source = $10
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
          source,
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
            -- Escopo por FONTE: um sync da Nestlé só expira cargas da Nestlé,
            -- nunca as da Shopee (e vice-versa). Defesa em profundidade — os ids
            -- já vêm escopados por fetchExistingSheetLoads(source).
            AND sheet_source = $2
        `,
        [staleTrulyGone, source],
      );
    });

    console.info(
      `[google-sheet-loads] ${staleTrulyGone.length} cargas removidas da planilha (OPEN→EXPIRED, RESERVED preservado)`,
      { count: staleTrulyGone.length },
    );
  }

  // "Puxar tudo da planilha" (fontes com pullAllRows, ex.: Nestlé): cria carga
  // BOOKED para as linhas JÁ ALOCADAS (motorista/status) que ainda não existem
  // como carga — nem entraram como disponíveis nesta rodada. Assim /cargas
  // espelha a planilha inteira, não só as disponíveis. Linhas já existentes são
  // mantidas pelo caminho staleInSheet (OPEN→BOOKED + refresh dos campos sheet_*).
  // data/horario são NOT NULL → linhas sem data são puladas (log). Shopee
  // (pullAllRows=false) não passa por aqui: comportamento 100% inalterado.
  let allocatedCreatedCount = 0;
  let allocatedSkippedNoDate = 0;
  if (pullAllRows) {
    const seenAllocated = new Set();
    const allocatedPayloads = [];
    for (const row of allSheetRows) {
      const lh = row.lh?.trim();
      if (!lh) continue;
      const isAllocated = Boolean((row.motoristas || "").trim() || (row.status || "").trim());
      if (!isAllocated) continue; // disponíveis já foram upsertadas como OPEN
      if (existingLoadsBySheetLh.has(lh)) continue; // já é carga → staleInSheet cuida
      if (currentSheetKeys.has(lh)) continue; // já upsertada como disponível nesta rodada
      if (seenAllocated.has(lh)) continue;
      if (!row.data || !row.horario) {
        allocatedSkippedNoDate += 1; // data/horario NOT NULL — não dá pra inserir
        continue;
      }
      seenAllocated.add(lh);
      allocatedPayloads.push(
        buildAllocatedSheetLoadPayload({
          row,
          routeCatalogDefaultsByKey,
          routeTemplateDefaultsByKey,
          fallbackSheetClientId,
          syncedAt,
          source,
        }),
      );
    }

    if (allocatedPayloads.length > 0) {
      const { error: allocatedUpsertError } = await supabaseClient
        .from(SHEET_LOADS_TABLE)
        .upsert(allocatedPayloads, { onConflict: "id" });

      if (allocatedUpsertError) {
        throw allocatedUpsertError;
      }

      allocatedCreatedCount = allocatedPayloads.length;
      console.info(
        `[google-sheet-loads] ${allocatedCreatedCount} cargas já alocadas importadas da planilha (BOOKED)`,
        { count: allocatedCreatedCount, source },
      );
    }

    if (allocatedSkippedNoDate > 0) {
      console.warn(
        `[google-sheet-loads] ${allocatedSkippedNoDate} linha(s) alocada(s) pulada(s) por falta de data de carregamento`,
        { count: allocatedSkippedNoDate, source },
      );
    }
  }

  // Persist a full snapshot (all rows + summary) so the Sheet Monitor
  // screen can read from the DB instead of fetching Google Sheets each time.
  // Per-source: cada fonte grava a própria linha (não faz clobber da outra).
  try {
    await updateSheetMonitorSnapshot({
      csvText,
      supabaseClient,
      source,
      headerSchema,
      clientName: clientName ?? (source === SHEET_SOURCE_SHOPEE ? DEFAULT_SHEET_CLIENT_NAME : undefined),
    });
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
    source,
    availableLoadsCount: sheetLoadPayloads.length,
    allocatedCreatedCount,
    unlinkedLoadsCount: staleInSheet.length + staleTrulyGone.length,
    revertedToOpenCount,
    revivedExpiredCount,
    skippedInvalidLoadsCount: invalidRows.length,
    cancelCascadeSwept,
    sheetUrl,
  };
}

// ── SHEET_SOURCES config + multi-source runner ──────────────────────────────
//
// Cada entrada descreve uma planilha a sincronizar. `getSheetSources()` é
// avaliada em runtime (lê env vars a cada chamada — assim testes podem setar
// GOOGLE_SHEET_NESTLE_URL etc. dinamicamente). A Shopee usa o CSV do
// GOOGLE_SHEET_ID/GID; a Nestlé usa GOOGLE_SHEET_NESTLE_URL (com default
// hardcodado) e um clientName configurável (staging usa "Nestle" sem acento;
// prod "Nestlé").
export function getSheetSources() {
  return [
    {
      source: SHEET_SOURCE_SHOPEE,
      clientName: DEFAULT_SHEET_CLIENT_NAME,
      sheetUrl: getSheetExportUrl(),
      headerSchema: SHOPEE_HEADER_SCHEMA,
      // Shopee: só disponíveis viram carga (alocadas entram via ciclo OPEN→BOOKED).
      pullAllRows: false,
    },
    {
      source: SHEET_SOURCE_NESTLE,
      clientName: process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME?.trim() || "Nestlé",
      sheetUrl: process.env.GOOGLE_SHEET_NESTLE_URL?.trim() || NESTLE_DEFAULT_SHEET_URL,
      headerSchema: NESTLE_HEADER_SCHEMA,
      // Nestlé: "puxar tudo" — importa a planilha inteira (alocadas viram BOOKED).
      pullAllRows: true,
    },
  ];
}

/**
 * Sincroniza TODAS as fontes de planilha em sequência, cada uma no PRÓPRIO
 * try/catch. Uma falha em uma fonte (ex.: cliente Nestlé inexistente no DB)
 * NÃO aborta as outras — o sync da Shopee sempre roda. Retorna um resumo por
 * fonte (result ou error). Aceita um subconjunto de fontes via `sources`
 * (default: getSheetSources()).
 */
export async function syncAllSheetSources({
  fetchImpl = globalThis.fetch,
  supabaseClient = createSupabaseAdminClient(),
  sources = getSheetSources(),
} = {}) {
  const results = [];

  for (const sourceConfig of sources) {
    try {
      const result = await syncGoogleSheetLoads({
        fetchImpl,
        supabaseClient,
        sheetUrl: sourceConfig.sheetUrl,
        clientName: sourceConfig.clientName,
        source: sourceConfig.source,
        headerSchema: sourceConfig.headerSchema,
        pullAllRows: sourceConfig.pullAllRows,
      });
      results.push({ source: sourceConfig.source, ok: true, result });
    } catch (error) {
      // Isolamento total: log estruturado + segue para a próxima fonte.
      console.error("[google-sheet-loads] sync de fonte falhou (isolado)", {
        source: sourceConfig.source,
        clientName: sourceConfig.clientName,
        name: error?.name,
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      });
      results.push({
        source: sourceConfig.source,
        ok: false,
        error: {
          name: error?.name ?? "Error",
          code: error?.code ?? null,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // Auto-cura do write-back: com os snapshots já frescos, grava na planilha as
  // cargas tomadas no sistema que ficaram em branco na planilha (só preenche
  // vazios). Isolado — nunca derruba o resultado do sync.
  try {
    const { reconcileTakenCargosToSheet } = await import("./reconcile-sheet-allocations.js");
    const reconcile = await reconcileTakenCargosToSheet();
    results.push({ source: "__reconcile_writeback__", ok: true, result: reconcile });
  } catch (error) {
    console.error("[google-sheet-loads] reconcile write-back falhou (isolado)", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { sources: results };
}
