// backend/src/application/repom/ocr-sidecar-client.js
//
// Cliente Node do sidecar de OCR (cadastro-motorista, FastAPI :8765) para o
// Repom. ESPELHA o padrão de `application/candidatura/use-cases/antt-cascade.js`
// (mesma URL/token/timeout), mas para o endpoint de extração de CNH.
//
// Decisão (Repom Fase 3b): NÃO reescrever OCR no Node — o sidecar já faz a
// extração multi-estratégia (Infosimples → GPT-4o Vision, com breaker/budget).
// Aqui só chamamos, achatamos o envelope e tratamos falha de INFRA como "suave"
// (o motorista reenvia) — nunca reprovamos o documento por rede/timeout.
//
// PR0: este módulo é isolado (ainda não plugado no flow-engine — isso é o PR3).

import "../../infrastructure/config/load-env.js";

const DEFAULT_SIDECAR_URL = "http://cadastro-ocr:8765";
const DEFAULT_TIMEOUT_MS = 45_000; // Infosimples (~30s) + fallback Vision (~15s).

function parsePositiveIntegerEnv(name, fallbackValue) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function getSidecarUrl() {
  return process.env.CADASTRO_OCR_URL?.trim() || DEFAULT_SIDECAR_URL;
}

/** Header do token compartilhado (mesmo do antt-cascade). Sem token → dev/compat. */
function getSidecarAuthHeaders() {
  const token = process.env.OCR_SIDECAR_TOKEN?.trim();
  return token ? { "X-OCR-Sidecar-Token": token } : {};
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("REPOM_OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

// Distribuidora "padrão" mandada ao endpoint de comprovante. Só orienta o parser
// por-distribuidora do sidecar; o fallback Vision lê qualquer conta. Configurável
// por env (mesma lista do wizard: cpfl|enel|cemig|light|energisa|neoenergia|rge|elektro).
function getComprovanteConcessionaria() {
  return process.env.REPOM_COMPROVANTE_CONCESSIONARIA?.trim() || "neoenergia";
}

/**
 * Achata `envelope.data[0].campos` num objeto plano { campo: valor }.
 * Cada campo pode vir como { valor: "..." } (Infosimples) ou valor cru (Vision).
 * Ignora campos vazios/nulos.
 */
export function flattenOcrCampos(envelope) {
  const item = Array.isArray(envelope?.data) ? envelope.data[0] : null;
  const campos = item && typeof item.campos === "object" && item.campos ? item.campos : {};
  const out = {};
  for (const [key, raw] of Object.entries(campos)) {
    const value = raw && typeof raw === "object" && "valor" in raw ? raw.valor : raw;
    if (value === null || value === undefined) continue;
    const str = typeof value === "string" ? value.trim() : value;
    if (str === "") continue;
    out[key] = str;
  }
  return out;
}

/**
 * Chamada CRUA ao sidecar OCR. Lança em HTTP != 2xx (igual callAnttSidecar).
 * Isolado para permitir mock nos testes.
 *
 * @param {object} p
 * @param {'cnh'|'comprovante-residencia'} p.docType - tipo do documento (endpoint do sidecar)
 * @param {string} p.imagemBase64 - imagem/PDF em base64 (sem prefixo data:)
 * @param {string} p.idCadastro  - id do cadastro (persistência do anexo no sidecar)
 * @param {Record<string,unknown>} [p.extraBody] - campos extras no corpo (ex.: comprovante → { concessionaria })
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<object>} envelope cru do sidecar
 */
export async function callOcrSidecar({ docType, imagemBase64, idCadastro, extraBody, signal }) {
  const url = `${getSidecarUrl().replace(/\/$/, "")}/api/ocr/${docType}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getSidecarAuthHeaders(),
    },
    body: JSON.stringify({ imagem: imagemBase64, id_cadastro: idCadastro, ...(extraBody || {}) }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(`OCR sidecar respondeu HTTP ${response.status}: ${text.slice(0, 200)}`);
    err.statusCode = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Extrai os campos da CNH via sidecar, com timeout e degradação SUAVE.
 *
 * Nunca lança: falha de rede/timeout OU envelope code != 200 (documento não
 * lido) devolvem `{ ok:false, requiresUpload:true }` — o caller pede reenvio.
 * Só `ok:true` traz `fields` (objeto plano) para os gates/validação (PR2/PR3).
 *
 * @param {object} args
 * @param {string} args.imagemBase64
 * @param {string} args.idCadastro
 * @param {string} [args.correlationId]
 * @returns {Promise<{
 *   ok: boolean,
 *   fields?: Record<string, unknown>,
 *   provider?: string|null,
 *   code?: number|null,
 *   codeMessage?: string|null,
 *   requiresUpload?: boolean,
 *   error?: string,
 * }>}
 */
async function extractDocFromMedia({ docType, imagemBase64, idCadastro, extraBody, correlationId, logTag = "ocr" }) {
  if (!imagemBase64 || !idCadastro) {
    return { ok: false, requiresUpload: true, error: "MISSING_IMAGE_OR_ID" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  let envelope;
  try {
    envelope = await callOcrSidecar({ docType, imagemBase64, idCadastro, extraBody, signal: controller.signal });
  } catch (err) {
    // Falha de INFRA (rede/timeout/HTTP != 2xx) → suave: motorista reenvia.
    console.warn(
      `[repom.${logTag}] ${correlationId || "-"} OCR indisponível:`,
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: false,
      requiresUpload: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  const code = envelope?.code ?? null;
  const provider = envelope?.header?.provider ?? null;

  // Documento não lido (Infosimples e fallback Vision falharam logicamente).
  if (code !== 200) {
    return {
      ok: false,
      requiresUpload: true,
      code,
      codeMessage: envelope?.code_message ?? null,
      provider,
    };
  }

  return { ok: true, fields: flattenOcrCampos(envelope), provider, code };
}

/** CNH → Infosimples (+fallback Vision), via /api/ocr/cnh. Nunca lança (degradação suave). */
export async function extractCnhFromMedia({ imagemBase64, idCadastro, correlationId } = {}) {
  return extractDocFromMedia({ docType: "cnh", imagemBase64, idCadastro, correlationId, logTag: "ocr" });
}

/**
 * Comprovante de residência → OpenAI Vision, via /api/ocr/comprovante-residencia.
 * Mesma degradação suave da CNH: nunca lança; falha → { ok:false } (o caller só
 * guarda o arquivo e segue — a extração do endereço é um BÔNUS, nunca trava).
 * `concessionaria` orienta o parser por-distribuidora do sidecar (o Vision cobre
 * o resto); no WhatsApp não sabemos qual é, então mandamos um padrão neutro.
 *
 * @param {object} args
 * @param {string} args.imagemBase64
 * @param {string} args.idCadastro
 * @param {string} [args.concessionaria]
 * @param {string} [args.correlationId]
 */
export async function extractComprovanteFromMedia({ imagemBase64, idCadastro, concessionaria, correlationId } = {}) {
  return extractDocFromMedia({
    docType: "comprovante-residencia",
    imagemBase64,
    idCadastro,
    extraBody: { concessionaria: concessionaria || getComprovanteConcessionaria() },
    correlationId,
    logTag: "ocr.comprovante",
  });
}
