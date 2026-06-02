/**
 * Stager de anexos para o pipeline de cadastro Angellira.
 *
 * GAP que este módulo fecha (Node-side): o bot angelira-bot é capaz de anexar
 * documentos (CNH, RG, cartão CNPJ, CRLV, comprovante) ao cadastrar
 * motorista/proprietário/veículo, mas só consegue lê-los a partir de um path
 * LOCAL no sandbox dele. Esse path é criado via `POST /api/anexo/salvar`
 * (body `{ tipo, imagem(base64), id_cadastro }` → `{ anexo_path }`).
 *
 * Os documentos originais vivem no bucket privado `cadastro-drafts` (Supabase
 * Storage), com os paths gravados no JSONB `dados` do cadastro. Este stager:
 *   1. para cada doc relevante da entidade, resolve o storage_path em `dados`;
 *   2. baixa os bytes via admin storage client (mesma config do
 *      upload-draft-file.js);
 *   3. base64-encoda e faz POST `/api/anexo/salvar` com o `tipo` correto
 *      (allowlist do bot — bots/angelira/backend/anexo_storage.py);
 *   4. coleta o `anexo_path` retornado e monta o mapa `anexos` keyed para os
 *      flows do bot (motorista: {cnh,rg}; owner PF: {cnh}; owner PJ:
 *      {cartao_cnpj}; veículo: {crlv}).
 *
 * BEST-EFFORT: um doc ausente ou que falhe NÃO derruba o step. O cadastro deve
 * concluir mesmo sem todos os anexos — apenas com aviso em log. O bot já trata
 * `anexos:{}` (não anexa nada).
 *
 * Epic DC-111 / Sprint 1 — anexos.
 */

import { DRAFT_FILE_BUCKET } from "../../../candidatura/use-cases/upload-draft-file.js";
import { getAdminClient } from "../../../load-claims/auth.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

const DEFAULT_BOT_URL = "http://angelira-bot:8765";
const STAGE_TIMEOUT_MS = 30_000;

/**
 * Resolve a base URL do sidecar angelira-bot — mesma lógica de
 * angellira-bot-client.js (env ANGELLIRA_BOT_URL, sem barra final).
 */
export function resolveBotBaseUrl() {
  const raw = process.env.ANGELLIRA_BOT_URL?.trim();
  return (raw || DEFAULT_BOT_URL).replace(/\/$/, "");
}

/**
 * Remove o prefixo `cadastro-drafts/` do storage_path quando presente. Os paths
 * no JSONB às vezes incluem o nome do bucket (ex.: `cadastro-drafts/<owner>/...`),
 * mas o storage client já opera DENTRO do bucket (`from(DRAFT_FILE_BUCKET)`), então
 * o prefixo precisa ser removido para o `.download()` não procurar
 * `cadastro-drafts/cadastro-drafts/...`.
 */
function stripBucketPrefix(path) {
  const p = String(path || "").trim().replace(/^\/+/, "");
  const prefix = `${DRAFT_FILE_BUCKET}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Converte um ArrayBuffer/Blob/Buffer em base64 puro (sem prefixo data:).
 */
async function toBase64(downloadData) {
  // supabase-js storage.download() retorna um Blob (Node 18+ tem Blob global).
  if (downloadData && typeof downloadData.arrayBuffer === "function") {
    const ab = await downloadData.arrayBuffer();
    return Buffer.from(ab).toString("base64");
  }
  if (downloadData instanceof ArrayBuffer) {
    return Buffer.from(downloadData).toString("base64");
  }
  if (Buffer.isBuffer(downloadData)) {
    return downloadData.toString("base64");
  }
  // Fallback defensivo: Uint8Array / array-like
  return Buffer.from(downloadData).toString("base64");
}

/**
 * Baixa um doc do bucket cadastro-drafts e o estaga no sandbox do bot via
 * POST /api/anexo/salvar. Best-effort: retorna o anexo_path em sucesso, ou
 * null (com log) em qualquer falha — NUNCA lança.
 *
 * @param {object} args
 * @param {object} args.storage          — admin storage client já em .from(bucket)
 * @param {string} args.baseUrl          — base URL do sidecar
 * @param {string} args.cadastroId
 * @param {string} args.storagePath      — path no bucket (com ou sem prefixo)
 * @param {string} args.tipo             — tipo na allowlist do bot
 * @param {string} args.docLabel         — rótulo p/ log (ex.: 'motorista.cnh')
 * @param {string} [args.correlationId]
 * @returns {Promise<string|null>} anexo_path no sandbox do bot, ou null.
 */
async function stageOneDoc({
  storage,
  baseUrl,
  cadastroId,
  storagePath,
  tipo,
  docLabel,
  correlationId,
}) {
  const cleanPath = stripBucketPrefix(storagePath);
  if (!cleanPath) return null;

  // 1) Download dos bytes do bucket privado.
  let base64;
  try {
    const { data, error } = await storage.download(cleanPath);
    if (error || !data) {
      logStructuredEvent("warn", "angellira.anexos.download_failed", {
        cadastroId,
        correlationId: correlationId ?? null,
        docLabel,
        tipo,
        path: cleanPath,
        message: error?.message || "download retornou vazio",
      });
      return null;
    }
    base64 = await toBase64(data);
    if (!base64) {
      logStructuredEvent("warn", "angellira.anexos.empty_after_decode", {
        cadastroId, correlationId: correlationId ?? null, docLabel, tipo, path: cleanPath,
      });
      return null;
    }
  } catch (err) {
    logStructuredEvent("warn", "angellira.anexos.download_exception", {
      cadastroId,
      correlationId: correlationId ?? null,
      docLabel,
      tipo,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 2) POST /api/anexo/salvar — estaga no sandbox do bot.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (correlationId) headers["X-Correlation-Id"] = correlationId;
    const response = await fetch(`${baseUrl}/api/anexo/salvar`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tipo, imagem: base64, id_cadastro: cadastroId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { detail: text.slice(0, 300) };
      }
    }

    if (response.ok && body?.ok && body?.anexo_path) {
      logStructuredEvent("info", "angellira.anexos.staged", {
        cadastroId,
        correlationId: correlationId ?? null,
        docLabel,
        tipo,
        bytes: body.bytes ?? null,
      });
      return body.anexo_path;
    }

    logStructuredEvent("warn", "angellira.anexos.stage_rejected", {
      cadastroId,
      correlationId: correlationId ?? null,
      docLabel,
      tipo,
      httpStatus: response.status,
      detail: typeof body?.detail === "string" ? body.detail : null,
    });
    return null;
  } catch (err) {
    clearTimeout(timeoutId);
    logStructuredEvent("warn", "angellira.anexos.stage_exception", {
      cadastroId,
      correlationId: correlationId ?? null,
      docLabel,
      tipo,
      timeout: err?.name === "AbortError",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve os storage_paths de uma entidade a partir de `dados`, mapeando cada
 * doc para a chave do mapa `anexos` que o bot lê + o `tipo` da allowlist.
 *
 * Chaves do mapa `anexos` por flow do bot (ver bots/angelira/.../flow_*.py):
 *   - motorista (flow_motorista): { cnh, rg }  (rg cai pra cnh se ausente)
 *   - proprietário (flow_proprietario): PF lê { cnh } → cnhFile;
 *     PJ lê { cartao_cnpj }/{ documento } → rgFile
 *   - veículo (flow_veiculo): { crlv }
 *
 * `tipo` (allowlist anexo_storage.py): cnh_motorista, rg_motorista,
 *   cnh_proprietario, cartao_cnpj, cartao_cnpj_carreta, crlv_cavalo, crlv_carreta.
 *
 * @param {object} dados   — pending_driver_registrations.dados (wizard v2)
 * @param {'motorista'|'cavalo_owner'|'carreta_owner'|'cavalo'|'carreta'} entity
 * @param {number} [idx]   — índice da carreta (carreta/carreta_owner). Default 0.
 * @returns {Array<{anexoKey:string, tipo:string, storagePath:string, docLabel:string}>}
 */
function resolveEntityDocs(dados, entity, idx = 0) {
  const docs = [];
  const push = (anexoKey, tipo, storagePath, docLabel) => {
    if (storagePath && typeof storagePath === "string" && storagePath.trim()) {
      docs.push({ anexoKey, tipo, storagePath: storagePath.trim(), docLabel });
    }
  };

  if (entity === "motorista") {
    const m = dados?.motorista || {};
    // CNH → cnhFile no bot (anexos.cnh) e rgFile no bot (anexos.rg).
    // Angellira usa o mesmo documento (CNH) tanto no campo "Imagem CNH" quanto
    // em "Imagem RG". A selfie com CNH (selfie_cnh_url) NÃO é enviada como RG.
    push("cnh", "cnh_motorista", m.cnh_url, "motorista.cnh_url");
    push("rg", "rg_motorista", m.cnh_url, "motorista.cnh_url");
    return docs;
  }

  if (entity === "cavalo") {
    push("crlv", "crlv_cavalo", dados?.cavalo?.crlv_url, "cavalo.crlv_url");
    return docs;
  }

  if (entity === "carreta") {
    const c = Array.isArray(dados?.carretas) ? dados.carretas[idx] : dados?.carreta;
    push("crlv", "crlv_carreta", c?.crlv_url, `carretas[${idx}].crlv_url`);
    return docs;
  }

  // Proprietários — owner_doc_url é CNH (PF) ou cartão CNPJ (PJ). O `tipo` e a
  // chave do mapa mudam conforme PF/PJ.
  if (entity === "cavalo_owner" || entity === "carreta_owner") {
    const owner = entity === "cavalo_owner"
      ? (dados?.cavalo_owner || {})
      : (Array.isArray(dados?.carreta_owners) ? (dados.carreta_owners[idx] || {}) : (dados?.carreta_owner || {}));
    const labelBase = entity === "cavalo_owner" ? "cavalo_owner" : `carreta_owners[${idx}]`;
    const isPJ = owner.tipo === "pj"
      || String(owner.doc || "").replace(/\D/g, "").length === 14;
    if (isPJ) {
      // Cartão CNPJ → bot lê anexos.cartao_cnpj/documento → rgFile.
      const tipo = entity === "carreta_owner" ? "cartao_cnpj_carreta" : "cartao_cnpj";
      push("cartao_cnpj", tipo, owner.owner_doc_url, `${labelBase}.owner_doc_url(cnpj)`);
    } else {
      // CNH do proprietário PF → bot lê anexos.cnh → cnhFile.
      push("cnh", "cnh_proprietario", owner.owner_doc_url, `${labelBase}.owner_doc_url(cnh)`);
    }
    return docs;
  }

  return docs;
}

/**
 * Estaga os anexos relevantes de uma entidade no sandbox do bot e devolve o
 * mapa `anexos` pronto pros flows. Best-effort: docs que faltem/falhem são
 * apenas pulados (com log) — o mapa retornado pode vir parcial ou vazio.
 *
 * @param {object} args
 * @param {object} args.dados
 * @param {'motorista'|'cavalo_owner'|'carreta_owner'|'cavalo'|'carreta'} args.entity
 * @param {string} args.cadastroId
 * @param {number} [args.idx]            — índice da carreta. Default 0.
 * @param {string} [args.baseUrl]        — base URL do bot (default: env).
 * @param {object} [args.storageClient]  — injetável p/ testes (admin storage client).
 * @param {string} [args.correlationId]
 * @returns {Promise<object>} mapa `anexos` (ex.: { cnh, rg } ou { crlv } ou {}).
 */
export async function stageAnexosForEntity({
  dados,
  entity,
  cadastroId,
  idx = 0,
  baseUrl,
  storageClient,
  correlationId,
}) {
  const docs = resolveEntityDocs(dados, entity, idx);
  if (!docs.length) return {};
  if (!cadastroId) {
    // Sem id_cadastro o bot rejeita o /api/anexo/salvar — pula anexos (não-fatal).
    logStructuredEvent("warn", "angellira.anexos.no_cadastro_id", { entity });
    return {};
  }

  const resolvedBaseUrl = baseUrl || resolveBotBaseUrl();
  let storage;
  try {
    const client = storageClient || getAdminClient();
    storage = client.storage.from(DRAFT_FILE_BUCKET);
  } catch (err) {
    // Sem storage client (env ausente em ambiente sem Supabase) — pula anexos.
    logStructuredEvent("warn", "angellira.anexos.storage_unavailable", {
      cadastroId,
      entity,
      correlationId: correlationId ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  const anexos = {};
  // Sequencial: o sandbox do bot escreve por id_cadastro; paralelizar não traz
  // ganho relevante (1-3 docs) e mantém o log mais legível.
  for (const doc of docs) {
    const anexoPath = await stageOneDoc({
      storage,
      baseUrl: resolvedBaseUrl,
      cadastroId,
      storagePath: doc.storagePath,
      tipo: doc.tipo,
      docLabel: doc.docLabel,
      correlationId,
    });
    if (anexoPath) {
      anexos[doc.anexoKey] = anexoPath;
    }
  }

  logStructuredEvent("info", "angellira.anexos.entity_done", {
    cadastroId,
    entity,
    correlationId: correlationId ?? null,
    keys: Object.keys(anexos),
    expected: docs.length,
  });

  return anexos;
}
