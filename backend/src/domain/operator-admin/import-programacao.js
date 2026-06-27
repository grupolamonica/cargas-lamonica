// Importação de programação de cargas via CSV (operador).
//
// Camada de domínio: parsing e validação puros, sem I/O.
// Colunas aceitas (formato da planilha de programação):
//   COD. CARGA, TIPO, VEÍCULO, DATA CARREGAMENTO, DATA DESCARGA, Origem, Destino, STATUS
//
// COD. CARGA é o LH do sistema → vira `sheet_lh` e a fonte do id determinístico
// do cargo (mesmo algoritmo do sync da planilha → dedupe por LH).
// VEÍCULO é o tipo do veículo (CARRETA/TRUCK/...) → `perfil`.
// TIPO é o tipo da viagem (Forecast, Spot, ...) → `sheet_tipo` (texto livre).
// CLIENTE é localizado pelo nome → `cliente_id`; se não existir, a linha é
// rejeitada; em branco, fica sem cliente.

import crypto from "node:crypto";

import { normalizeVehicleProfile } from "../vehicle-profiles.js";

// Aliases de cabeçalho → coluna canônica. Chaves já normalizadas
// (sem acento, minúsculas, sem pontuação, espaços colapsados).
const COLUMN_ALIASES = new Map([
  ["cod carga", "cod_carga"],
  ["codigo carga", "cod_carga"],
  ["codigo da carga", "cod_carga"],
  ["cod", "cod_carga"],
  ["lh", "cod_carga"],
  ["tipo", "tipo"],
  ["tipo viagem", "tipo"],
  ["tipo de viagem", "tipo"],
  ["veiculo", "veiculo"],
  ["tipo de veiculo", "veiculo"],
  ["tipo veiculo", "veiculo"],
  ["perfil", "veiculo"],
  ["data carregamento", "data_carregamento"],
  ["data de carregamento", "data_carregamento"],
  ["carregamento", "data_carregamento"],
  ["data descarga", "data_descarga"],
  ["data de descarga", "data_descarga"],
  ["descarga", "data_descarga"],
  ["origem", "origem"],
  ["destino", "destino"],
  ["cliente", "cliente"],
  ["nome do cliente", "cliente"],
  ["cliente nome", "cliente"],
  ["status", "status"],
  ["situacao", "status"],
]);

const REQUIRED_COLUMNS = ["cod_carga", "data_carregamento", "origem", "destino"];

// Rótulos amigáveis (para mensagem de cabeçalho ausente).
export const COLUMN_LABELS = {
  cod_carga: "COD. CARGA",
  tipo: "TIPO",
  veiculo: "VEÍCULO",
  data_carregamento: "DATA CARREGAMENTO",
  data_descarga: "DATA DESCARGA",
  origem: "Origem",
  destino: "Destino",
  cliente: "CLIENTE",
  status: "STATUS",
};

// Cabeçalho do modelo (CSV de exemplo) baixado pelo operador.
export const TEMPLATE_HEADERS = [
  "COD. CARGA",
  "TIPO",
  "VEÍCULO",
  "DATA CARREGAMENTO",
  "DATA DESCARGA",
  "Origem",
  "Destino",
  "CLIENTE",
  "STATUS",
];

export const TEMPLATE_EXAMPLE_ROWS = [
  [
    "LH-0012345",
    "Forecast",
    "CARRETA",
    "15/07/2026 08:00",
    "16/07/2026 18:00",
    "São Paulo - SP",
    "Rio de Janeiro - RJ",
    "Shopee",
    "rascunho",
  ],
  [
    "LH-0012346",
    "Spot",
    "TRUCK",
    "16/07/2026 13:30",
    "17/07/2026 10:00",
    "Campinas - SP",
    "Belo Horizonte - MG",
    "",
    "ativa",
  ],
];

// Status pt-BR/legado → canônico de criação (apenas DRAFT/OPEN são válidos).
const STATUS_ALIASES = new Map([
  ["rascunho", "DRAFT"],
  ["draft", "DRAFT"],
  ["ativa", "OPEN"],
  ["ativo", "OPEN"],
  ["aberta", "OPEN"],
  ["open", "OPEN"],
  ["publicada", "OPEN"],
]);

// Detecta o separador pela 1ª linha. Excel em pt-BR salva CSV com ';' (a vírgula
// é o separador decimal), então aceitamos tanto ',' quanto ';'.
export function detectCsvDelimiter(text) {
  const firstLine = String(text ?? "").split(/\r?\n/, 1)[0] || "";
  let commas = 0;
  let semicolons = 0;
  let insideQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') insideQuotes = !insideQuotes;
    else if (!insideQuotes && ch === ",") commas += 1;
    else if (!insideQuotes && ch === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

// Separa texto CSV em matriz de células. Detecta o separador (',' ou ';'),
// suporta aspas duplas (escape ""), CRLF/LF e remove BOM inicial. Linhas
// totalmente vazias são descartadas.
export function splitCsvRows(text) {
  const raw = String(text ?? "");
  const sourceText = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const delimiter = detectCsvDelimiter(sourceText);
  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let index = 0; index < sourceText.length; index += 1) {
    const char = sourceText[index];

    if (insideQuotes) {
      if (char === '"') {
        if (sourceText[index + 1] === '"') {
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
    if (char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
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
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  return rows;
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// Chave de cabeçalho: sem acento, minúsculo, sem pontuação, espaços colapsados.
// "COD. CARGA" / "COD.CARGA" / "COD CARGA" → "cod carga".
export function normalizeHeaderKey(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Chave de comparação de nome de cliente (sem acento, minúsculo, espaços
// colapsados; pontuação preservada). Use idêntica na escrita e na leitura.
export function normalizeClientName(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// ── id determinístico por LH (mesmo algoritmo do sync da planilha) ──
// Garante que importar um LH já sincronizado pela planilha não duplique a carga.
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

export function buildSheetLoadId(codCarga) {
  const hash = crypto.createHash("sha1").update(`sheet-load:${codCarga}`).digest("hex");
  return formatUuidFromHex(hash);
}

// Aceita dd/mm/aaaa, dd-mm-aaaa ou aaaa-mm-dd. Devolve ISO (YYYY-MM-DD) ou null.
export function parseImportDate(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const segments = trimmed.split(/[/-]/).map((part) => Number(part));
  if (segments.length !== 3 || segments.some((part) => !Number.isInteger(part))) {
    return null;
  }

  let year;
  let month;
  let day;
  if (/^\d{4}[/-]/.test(trimmed)) {
    [year, month, day] = segments;
  } else {
    [day, month, year] = segments;
  }

  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

// Aceita HH:MM ou HH:MM:SS. Devolve HH:MM ou null.
export function parseImportTime(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return `${pad2(hours)}:${pad2(minutes)}`;
}

// "15/07/2026 08:00" / "15/07/2026" / "2026-07-15 08:00:00".
// Devolve { date: ISO, time: HH:MM (00:00 se ausente), label: DD/MM/AAAA HH:MM } ou null.
export function parseImportDateTime(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const [datePart, timePart] = trimmed.split(/\s+/);
  const isoDate = parseImportDate(datePart);
  if (!isoDate) return null;

  let time = "00:00";
  if (timePart) {
    const parsedTime = parseImportTime(timePart);
    if (!parsedTime) return null;
    time = parsedTime;
  }

  const [yyyy, mm, dd] = isoDate.split("-");
  return { date: isoDate, time, label: `${dd}/${mm}/${yyyy} ${time}` };
}

/**
 * Mapeia o cabeçalho do CSV. Retorna o índice de cada coluna canônica e a lista
 * de colunas obrigatórias ausentes (rótulos amigáveis).
 */
export function buildHeaderIndex(headerRow) {
  const indexByColumn = new Map();
  (headerRow || []).forEach((rawHeader, index) => {
    const canonical = COLUMN_ALIASES.get(normalizeHeaderKey(rawHeader));
    if (canonical && !indexByColumn.has(canonical)) {
      indexByColumn.set(canonical, index);
    }
  });

  const missingRequired = REQUIRED_COLUMNS.filter((column) => !indexByColumn.has(column)).map(
    (column) => COLUMN_LABELS[column] || column,
  );
  return { indexByColumn, missingRequired };
}

function cellAt(cells, indexByColumn, column) {
  const index = indexByColumn.get(column);
  if (index === undefined) return "";
  return String(cells[index] ?? "").trim();
}

/**
 * Valida e converte uma linha do CSV em payload de carga.
 *
 * @param {string[]} cells linha já separada
 * @param {Map<string, number>} indexByColumn saída de buildHeaderIndex
 * @param {object} [opts]
 * @param {Map<string, {id: string, nome: string}>} [opts.clientesByName] nome-normalizado → cliente
 * @returns {{ok: boolean, errors: string[], payload?: object, preview: object}}
 */
export function parseImportRow(cells, indexByColumn, { clientesByName } = {}) {
  const errors = [];

  const codCarga = cellAt(cells, indexByColumn, "cod_carga");
  const rawTipo = cellAt(cells, indexByColumn, "tipo");
  const rawVeiculo = cellAt(cells, indexByColumn, "veiculo");
  const rawCarregamento = cellAt(cells, indexByColumn, "data_carregamento");
  const rawDescarga = cellAt(cells, indexByColumn, "data_descarga");
  const origem = cellAt(cells, indexByColumn, "origem");
  const destino = cellAt(cells, indexByColumn, "destino");
  const rawCliente = cellAt(cells, indexByColumn, "cliente");
  const rawStatus = cellAt(cells, indexByColumn, "status");

  if (!codCarga) errors.push("COD. CARGA é obrigatório.");

  const carregamento = parseImportDateTime(rawCarregamento);
  if (!carregamento) {
    errors.push(`DATA CARREGAMENTO inválida: "${rawCarregamento}" (use dd/mm/aaaa ou dd/mm/aaaa hh:mm).`);
  }

  let descargaLabel = null;
  if (rawDescarga) {
    const descarga = parseImportDateTime(rawDescarga);
    if (!descarga) errors.push(`DATA DESCARGA inválida: "${rawDescarga}".`);
    else descargaLabel = descarga.label;
  }

  if (origem.length < 2) errors.push("Origem é obrigatória (mín. 2 caracteres).");
  if (origem.length > 180) errors.push("Origem excede 180 caracteres.");
  if (destino.length < 2) errors.push("Destino é obrigatório (mín. 2 caracteres).");
  if (destino.length > 180) errors.push("Destino excede 180 caracteres.");

  // VEÍCULO → perfil canônico (CARRETA/TRUCK/...); valores não-veiculares caem em CARRETA.
  const perfil = normalizeVehicleProfile(rawVeiculo, "CARRETA");

  let status = "DRAFT";
  if (rawStatus) {
    const normalized = STATUS_ALIASES.get(normalizeText(rawStatus));
    if (!normalized) errors.push(`Status inválido: "${rawStatus}" (use rascunho ou ativa).`);
    else status = normalized;
  }

  // CLIENTE localizado pelo nome; se informado e não existir, rejeita a linha.
  let clienteId = null;
  let clienteNome = null;
  if (rawCliente) {
    const match = clientesByName?.get(normalizeClientName(rawCliente));
    if (match) {
      clienteId = match.id;
      clienteNome = match.nome;
    } else {
      errors.push(`Cliente não encontrado: "${rawCliente}". Cadastre o cliente antes de importar.`);
    }
  }

  const preview = {
    cod_carga: codCarga || null,
    tipo: rawTipo || null,
    veiculo: perfil,
    data: carregamento?.date ?? rawCarregamento,
    horario: carregamento?.time ?? "",
    data_descarga: descargaLabel,
    origem,
    destino,
    cliente_nome: clienteNome || rawCliente || null,
    status,
  };

  if (errors.length > 0) {
    return { ok: false, errors, preview };
  }

  return {
    ok: true,
    errors: [],
    preview,
    payload: {
      id: buildSheetLoadId(codCarga),
      sheet_lh: codCarga,
      data: carregamento.date,
      horario: carregamento.time,
      origem,
      destino,
      perfil,
      sheet_tipo: rawTipo || null,
      cliente_id: clienteId,
      status,
      driver_visibility: "PUBLIC",
      is_template: false,
      sheet_data_carregamento: carregamento.label,
      sheet_data_descarga: descargaLabel,
    },
  };
}
