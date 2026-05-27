// backend/src/application/candidatura/use-cases/antt-cascade.js
//
// Cascada ANTT — chama o sidecar FastAPI (cadastro-motorista) que implementa
// internamente a cascata Infosimples de 5 produtos com short-circuit:
//   1) antt/transportador {cpf}        — TAC (pessoa fisica)
//   2) antt/transportador {cnpj}       — ETC/CTC (pessoa juridica)
//   3) antt/veiculo {placa}            — placa-only
//   4) antt/registro-rntrc {placa}     — variante alternativa
//   5) antt/consulta-rntrc {placa+doc} — ultimo recurso
//
// Decisao (D-12 + plan 07-04): NAO duplicar a logica de cascade — o sidecar
// Python ja a expoe em POST /api/consulta/antt-veiculo. Aqui apenas chamamos
// o endpoint, mapeamos o resultado para o shape esperado pelo submit-final
// e propagamos as tentativas para o audit log.
//
// O endpoint do sidecar retorna:
//   - sucesso: { code: 200, data: [...], _produto_usado: "antt/transportador", tentativas: [...] }
//   - falha total: { code: 612, code_message, data: [], tentativas: [...] }
//
// Env vars:
//   CADASTRO_OCR_URL              — URL do sidecar (default http://cadastro-ocr:8765)
//   INFOSIMPLES_TIMEOUT_MS        — timeout total da chamada (default 30000)
//   ANTT_CASCADE_OVERALL_TIMEOUT_MS — fallback se o anterior nao estiver setado

import "../../../infrastructure/config/load-env.js";

const DEFAULT_SIDECAR_URL = "http://cadastro-ocr:8765";
const DEFAULT_PER_PRODUCT_TIMEOUT_MS = 30_000;
// Cascade total worst-case = 5 produtos * 30s = 150s. Margem de seguranca: +30s.
const OVERALL_TIMEOUT_MARGIN_MS = 30_000;

function parsePositiveIntegerEnv(name, fallbackValue) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function getSidecarUrl() {
  return process.env.CADASTRO_OCR_URL?.trim() || DEFAULT_SIDECAR_URL;
}

/**
 * Retorna o token estatico compartilhado com o sidecar Python (header
 * X-OCR-Sidecar-Token). Se vazio/ausente, o sidecar permite a chamada
 * em modo dev (compat). Em producao, deve casar com OCR_SIDECAR_TOKEN
 * do .env do sidecar.
 */
function getSidecarAuthHeaders() {
  const token = process.env.OCR_SIDECAR_TOKEN?.trim();
  return token ? { "X-OCR-Sidecar-Token": token } : {};
}

function getPerProductTimeoutMs() {
  return parsePositiveIntegerEnv("INFOSIMPLES_TIMEOUT_MS", DEFAULT_PER_PRODUCT_TIMEOUT_MS);
}

function getOverallTimeoutMs() {
  // 5 produtos no worst case + margem.
  return getPerProductTimeoutMs() * 5 + OVERALL_TIMEOUT_MARGIN_MS;
}

/**
 * Normaliza CPF/CNPJ removendo nao-digitos.
 */
function stripDocDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Normaliza placa removendo nao-alfanumericos e uppercase.
 */
function normalizePlate(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Extrai os campos relevantes do objeto data[0] retornado pelo Infosimples
 * (shape pode variar entre produtos — usamos fallbacks defensivos).
 *
 * FEAT-ANTT-TITULAR (2026-05): alem dos campos RNTRC ja extraidos, agora
 * retornamos tambem `titular_doc` (CPF/CNPJ do titular do RNTRC na ANTT) e
 * `titular_nome` (razao social ou nome do titular). O Infosimples expoe esses
 * campos com nomes variaveis por produto — usamos fallback defensivo.
 *
 * Quando `titular_doc` difere do `owner_doc` extraido do CRLV, sabemos que o
 * RNTRC pertence a outra pessoa (caso comum em arrendamento). O submit-final
 * usa essa flag para acionar o mini-form de captura de dados do titular ANTT.
 */
function stripDocOnly(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14 ? digits : null;
}

function extractAnttFields(dataItem) {
  if (!dataItem || typeof dataItem !== "object") return {};

  const titularDocRaw =
    dataItem.cpf_titular ||
    dataItem.cnpj_titular ||
    dataItem.documento_titular ||
    dataItem.cpf_transportador ||
    dataItem.cnpj_transportador ||
    dataItem.documento_transportador ||
    dataItem.cpf_proprietario ||
    dataItem.cnpj_proprietario ||
    dataItem.documento ||
    dataItem.cpf ||
    dataItem.cnpj ||
    null;

  const titularNome =
    dataItem.nome_titular ||
    dataItem.nome_transportador ||
    dataItem.razao_social ||
    dataItem.nome ||
    dataItem.proprietario ||
    dataItem.responsavel ||
    null;

  return {
    rntrc: dataItem.rntrc || dataItem.numero_rntrc || dataItem.registro_rntrc || null,
    tipo: dataItem.tipo || dataItem.categoria || dataItem.tipo_transportador || null,
    situacao: dataItem.situacao || dataItem.status || null,
    validade:
      dataItem.validade ||
      dataItem.data_validade ||
      dataItem.vencimento ||
      dataItem.data_vencimento ||
      null,
    titular_doc: stripDocOnly(titularDocRaw),
    titular_nome: titularNome ? String(titularNome).trim() : null,
  };
}

/**
 * Cliente HTTP do sidecar. Isolado para permitir mock no test.
 * Usa fetch (Node 18+).
 *
 * @param {Object} params
 * @param {string} [params.cpf]
 * @param {string} [params.cnpj]
 * @param {string} params.placa
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} resposta crua do sidecar (com tentativas[], code, data, etc.)
 */
export async function callAnttSidecar({ cpf, cnpj, placa, signal }) {
  const url = `${getSidecarUrl().replace(/\/$/, "")}/api/consulta/antt-veiculo`;
  const body = { placa };
  if (cpf) body.cpf = cpf;
  if (cnpj) body.cnpj = cnpj;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getSidecarAuthHeaders(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(
      `ANTT sidecar respondeu HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
    err.statusCode = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Resolve a cascata ANTT para um veiculo/proprietario.
 *
 * @param {Object} args
 * @param {'cpf'|'cnpj'} args.docType
 * @param {string} args.doc           CPF ou CNPJ do proprietario (com ou sem mascara).
 * @param {string} args.placa         Placa do veiculo (Mercosul ou antigo).
 * @param {string} [args.correlationId]
 * @returns {Promise<{
 *   rntrc: string|null,
 *   tipo: string|null,
 *   situacao: string|null,
 *   validade: string|null,
 *   titular_doc: string|null,
 *   titular_nome: string|null,
 *   source: string|null,
 *   requiresUpload?: boolean,
 *   attempts: Array<{ produto: string, code?: number, erro?: string }>
 * }>}
 */
export async function resolveAnttCascade({ docType, doc, placa, correlationId }) {
  const normalizedDoc = stripDocDigits(doc);
  const normalizedPlate = normalizePlate(placa);

  if (!normalizedPlate || normalizedPlate.length !== 7) {
    throw new Error("Placa invalida para cascata ANTT (esperado 7 caracteres alfanumericos).");
  }

  const params = { placa: normalizedPlate };
  if (docType === "cpf" && normalizedDoc.length === 11) {
    params.cpf = normalizedDoc;
  } else if (docType === "cnpj" && normalizedDoc.length === 14) {
    params.cnpj = normalizedDoc;
  }

  // AbortController para timeout total da cascade.
  const controller = new AbortController();
  const overallTimeout = getOverallTimeoutMs();
  const timer = setTimeout(() => controller.abort(), overallTimeout);

  let sidecarResponse;
  try {
    sidecarResponse = await callAnttSidecar({ ...params, signal: controller.signal });
  } catch (err) {
    // Falha de rede / timeout total → tratamos como cascade-failed (requiresUpload).
    return {
      rntrc: null,
      tipo: null,
      situacao: null,
      validade: null,
      titular_doc: null,
      titular_nome: null,
      source: null,
      requiresUpload: true,
      attempts: [
        {
          produto: "antt-cascade-network",
          erro: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }

  const attempts = Array.isArray(sidecarResponse?.tentativas)
    ? sidecarResponse.tentativas
    : [];

  // Sucesso: o sidecar retorna code 200 com data nao-vazio e _produto_usado.
  if (sidecarResponse?.code === 200 && Array.isArray(sidecarResponse?.data) && sidecarResponse.data.length > 0) {
    const fields = extractAnttFields(sidecarResponse.data[0]);
    const produto = sidecarResponse._produto_usado || (attempts[attempts.length - 1]?.produto ?? "antt-cascade");

    return {
      rntrc: fields.rntrc,
      tipo: fields.tipo,
      situacao: fields.situacao,
      validade: fields.validade,
      titular_doc: fields.titular_doc || null,
      titular_nome: fields.titular_nome || null,
      source: `antt-cascade-${produto}`,
      attempts,
    };
  }

  // Falha total (code 612 ou outro): nenhum produto retornou success.
  return {
    rntrc: null,
    tipo: null,
    situacao: null,
    validade: null,
    titular_doc: null,
    titular_nome: null,
    source: null,
    requiresUpload: true,
    attempts,
  };
}
