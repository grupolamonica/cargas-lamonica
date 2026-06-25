/**
 * Stager de anexos para o pipeline de cadastro SPX.
 *
 * Mesma técnica do angellira/anexos-stager.js: o spx-bot só consegue subir um
 * documento pro portal SPX a partir de um path LOCAL no sandbox dele. Esse path
 * é criado via `POST /spx/anexo/salvar` (body `{ tipo, imagem(base64), id_cadastro }`
 * → `{ anexo_path }`). Os documentos originais vivem no bucket Supabase
 * `cadastro-drafts` (wizard) ou no share local da produção (migrados).
 *
 * Este stager resolve, baixa, base64-encoda e estaga os docs do SPX:
 *   - CNH (frente; verso vem do split na Fase 3)   -> cnh_frente_path / cnh_verso_path
 *   - selfie com CNH                                -> selfie_path
 *   - CRLV do cavalo                                -> crlv_path
 *   - dossiê de gerenciamento de risco (Fase 1)     -> risk_doc_path
 *
 * O risk_doc vem SEMPRE do bucket de risco (gerado pela unificada na Fase 1),
 * independente de o cadastro ser do wizard ou migrado.
 *
 * BEST-EFFORT: um doc ausente/que falhe NÃO derruba o disparo — apenas loga e
 * o mapa volta parcial. O bot trata paths ausentes (não anexa aquele doc).
 *
 * Epic SPX (extensão Lamônica) — Fase 2 (ponte de anexos).
 */

import fs from "node:fs";
import path from "node:path";

import { DRAFT_FILE_BUCKET } from "../../../candidatura/use-cases/upload-draft-file.js";
import { getAdminClient } from "../../../load-claims/auth.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

const DEFAULT_BOT_URL = "http://spx-bot:8766";
const STAGE_TIMEOUT_MS = 30_000;
// Bucket onde a Fase 1 (generate-dossie) gravou o dossiê. Mesmo default/env.
const RISK_DOC_BUCKET = process.env.RISK_DOC_BUCKET?.trim() || "cadastro-drafts";
// Cadastros migrados do bot WhatsApp: docs no share local da produção.
const PRODUCAO_DOCS_BASE = process.env.PRODUCAO_DOCS_BASE || "H:\\Operacao\\CADASTROWHATS";

/** Base URL do sidecar spx-bot (env SPX_BOT_URL, sem barra final). */
export function resolveSpxBotBaseUrl() {
  const raw = process.env.SPX_BOT_URL?.trim();
  return (raw || DEFAULT_BOT_URL).replace(/\/$/, "");
}

/** Remove o prefixo `<bucket>/` do storage_path quando presente. */
function stripBucketPrefix(storagePath, bucket) {
  const p = String(storagePath || "").trim().replace(/^\/+/, "");
  const prefix = `${bucket}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Converte Blob/ArrayBuffer/Buffer (download do Supabase) em base64 puro. */
async function toBase64(downloadData) {
  if (downloadData && typeof downloadData.arrayBuffer === "function") {
    return Buffer.from(await downloadData.arrayBuffer()).toString("base64");
  }
  if (downloadData instanceof ArrayBuffer) return Buffer.from(downloadData).toString("base64");
  if (Buffer.isBuffer(downloadData)) return downloadData.toString("base64");
  return Buffer.from(downloadData).toString("base64");
}

/** Localiza arquivo no share: {base}/dados_motoristas/{id}/{sub}/{slug}.* (ext varia). */
function findLocalProdDoc(motoristaId, sub, slug) {
  try {
    const dir = path.join(PRODUCAO_DOCS_BASE, "dados_motoristas", String(motoristaId), sub);
    if (!fs.existsSync(dir)) return null;
    const alvo = `${slug.toLowerCase()}.`;
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase().startsWith(alvo));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/** POST base64 -> /spx/anexo/salvar. Best-effort: anexo_path ou null. */
async function postAnexo({ baseUrl, cadastroId, base64, tipo, docLabel, correlationId }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (correlationId) headers["X-Correlation-Id"] = correlationId;
    const response = await fetch(`${baseUrl}/spx/anexo/salvar`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tipo, imagem: base64, id_cadastro: cadastroId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 300) }; } }
    if (response.ok && body?.ok && body?.anexo_path) {
      logStructuredEvent("info", "spx.anexos.staged", {
        cadastroId, correlationId: correlationId ?? null, docLabel, tipo, bytes: body.bytes ?? null,
      });
      return body.anexo_path;
    }
    logStructuredEvent("warn", "spx.anexos.stage_rejected", {
      cadastroId, correlationId: correlationId ?? null, docLabel, tipo,
      httpStatus: response.status, detail: typeof body?.detail === "string" ? body.detail : null,
    });
    return null;
  } catch (err) {
    clearTimeout(timeoutId);
    logStructuredEvent("warn", "spx.anexos.stage_exception", {
      cadastroId, correlationId: correlationId ?? null, docLabel, tipo,
      timeout: err?.name === "AbortError",
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Baixa do bucket + estaga. Best-effort. */
async function stageFromBucket({ storage, baseUrl, cadastroId, bucket, bucketPath, tipo, docLabel, correlationId }) {
  const cleanPath = stripBucketPrefix(bucketPath, bucket);
  if (!cleanPath) return null;
  try {
    const { data, error } = await storage.download(cleanPath);
    if (error || !data) {
      logStructuredEvent("warn", "spx.anexos.download_failed", {
        cadastroId, correlationId: correlationId ?? null, docLabel, tipo, path: cleanPath,
        message: error?.message || "download vazio",
      });
      return null;
    }
    const base64 = await toBase64(data);
    if (!base64) return null;
    return postAnexo({ baseUrl, cadastroId, base64, tipo, docLabel, correlationId });
  } catch (err) {
    logStructuredEvent("warn", "spx.anexos.download_exception", {
      cadastroId, correlationId: correlationId ?? null, docLabel, tipo,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Lê arquivo local (share) + estaga. Best-effort. */
async function stageFromLocal({ baseUrl, cadastroId, absPath, tipo, docLabel, correlationId }) {
  let base64;
  try {
    base64 = await fs.promises.readFile(absPath, { encoding: "base64" });
    if (!base64) return null;
  } catch (err) {
    logStructuredEvent("warn", "spx.anexos.local_read_failed", {
      cadastroId, correlationId: correlationId ?? null, docLabel, tipo, path: absPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return postAnexo({ baseUrl, cadastroId, base64, tipo, docLabel, correlationId });
}

/**
 * Estaga os anexos do SPX no sandbox do bot e devolve o mapa de paths pronto
 * pro payload-mapper (cnh_frente_path, cnh_verso_path, selfie_path, crlv_path,
 * risk_doc_path). Best-effort: chaves que falharem ficam ausentes.
 *
 * @param {object} args
 * @param {object} args.dados                pending_driver_registrations.dados
 * @param {string} args.cadastroId
 * @param {string|null} [args.riskDocBucketPath]  storage_path do dossiê (Fase 1)
 * @param {string} [args.baseUrl]            base URL do spx-bot (default: env)
 * @param {object} [args.storageClient]      injetável p/ testes (admin client)
 * @param {string} [args.correlationId]
 * @returns {Promise<object>} mapa de *_path (parcial/vazio em best-effort).
 */
export async function stageSpxAnexos({
  dados,
  cadastroId,
  riskDocBucketPath = null,
  baseUrl,
  storageClient,
  correlationId,
}) {
  if (!cadastroId) {
    logStructuredEvent("warn", "spx.anexos.no_cadastro_id", {});
    return {};
  }
  const resolvedBaseUrl = baseUrl || resolveSpxBotBaseUrl();
  const anexos = {};
  const migradoId = dados?._origem?.motorista_id;

  // Admin storage client (bucket do wizard + bucket do risk_doc). Lazy + tolerante.
  let adminClient = null;
  const storageFrom = (bucket) => {
    if (!adminClient) adminClient = storageClient || getAdminClient();
    return adminClient.storage.from(bucket);
  };

  // ── 1. Docs do cadastro (CNH/selfie/CRLV) ────────────────────────────────
  // PRIORIDADE bucket (*_url no dados): vale pro wizard E pro migrado que já teve
  // os docs subidos pro Storage (migrate-prod-docs-to-storage, que resolve até a
  // CNH do owner-motorista). É o caminho DURÁVEL e o único que funciona no VPS.
  // FALLBACK share local: só migrado SEM docs no Storage (dev/SERVERBD com H:).
  const m = dados?.motorista || {};
  const temUrls = m.cnh_url || m.cnh_verso_url || m.selfie_cnh_url || dados?.cavalo?.crlv_url;
  try {
    if (temUrls) {
      const storage = storageFrom(DRAFT_FILE_BUCKET);
      const specs = [
        { key: "cnh_frente_path", tipo: "cnh_frente", url: m.cnh_url, label: "motorista.cnh_url" },
        { key: "cnh_verso_path", tipo: "cnh_verso", url: m.cnh_verso_url, label: "motorista.cnh_verso_url" },
        { key: "selfie_path", tipo: "selfie_cnh", url: m.selfie_cnh_url, label: "motorista.selfie_cnh_url" },
        { key: "crlv_path", tipo: "crlv_cavalo", url: dados?.cavalo?.crlv_url, label: "cavalo.crlv_url" },
      ];
      for (const s of specs) {
        if (!s.url) continue;
        const p = await stageFromBucket({
          storage, baseUrl: resolvedBaseUrl, cadastroId, bucket: DRAFT_FILE_BUCKET,
          bucketPath: s.url, tipo: s.tipo, docLabel: s.label, correlationId,
        });
        if (p) anexos[s.key] = p;
      }
    } else if (migradoId) {
      // Migrado SEM docs no Storage: fallback share local da produção. CNH do
      // owner-motorista (motorista=proprietário) fica em proprietario/cavalo-prop-cnh.
      const motoristaEhProp = String(dados?.motorista?.tambem_proprietario ?? "").toLowerCase() === "true"
        || dados?.motorista?.tambem_proprietario === true;
      const cnhSpec = motoristaEhProp
        ? { key: "cnh_frente_path", tipo: "cnh_frente", sub: "proprietario", slugs: ["cavalo-prop-cnh", "cnh-proprietario"] }
        : { key: "cnh_frente_path", tipo: "cnh_frente", sub: "motorista", slugs: ["cnh-motorista-frente", "cnh-motorista"] };
      const specs = [
        cnhSpec,
        { key: "cnh_verso_path", tipo: "cnh_verso", sub: "motorista", slugs: ["cnh-motorista-verso"] },
        { key: "selfie_path", tipo: "selfie_cnh", sub: "motorista", slugs: ["selfie-cnh", "foto-selfie", "selfie"] },
        { key: "crlv_path", tipo: "crlv_cavalo", sub: "veiculo", slugs: ["crlv-cavalo"] },
      ];
      for (const s of specs) {
        let abs = null;
        for (const slug of s.slugs) { abs = findLocalProdDoc(migradoId, s.sub, slug); if (abs) break; }
        if (!abs) {
          logStructuredEvent("warn", "spx.anexos.local_nao_encontrado", {
            cadastroId, correlationId: correlationId ?? null, key: s.key, sub: s.sub, motoristaId: migradoId,
          });
          continue;
        }
        const p = await stageFromLocal({
          baseUrl: resolvedBaseUrl, cadastroId, absPath: abs, tipo: s.tipo,
          docLabel: `${s.key}(local)`, correlationId,
        });
        if (p) anexos[s.key] = p;
      }
    }
  } catch (err) {
    logStructuredEvent("warn", "spx.anexos.docs_storage_unavailable", {
      cadastroId, correlationId: correlationId ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 2. Risk Doc (dossiê) — SEMPRE do bucket de risco (gerado na Fase 1) ───
  if (riskDocBucketPath) {
    try {
      const storage = storageFrom(RISK_DOC_BUCKET);
      const p = await stageFromBucket({
        storage, baseUrl: resolvedBaseUrl, cadastroId, bucket: RISK_DOC_BUCKET,
        bucketPath: riskDocBucketPath, tipo: "risk_doc", docLabel: "risk_doc", correlationId,
      });
      if (p) anexos.risk_doc_path = p;
    } catch (err) {
      logStructuredEvent("warn", "spx.anexos.riskdoc_storage_unavailable", {
        cadastroId, correlationId: correlationId ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logStructuredEvent("info", "spx.anexos.done", {
    cadastroId, correlationId: correlationId ?? null,
    keys: Object.keys(anexos), migrado: !!migradoId, temRiskDoc: !!riskDocBucketPath,
  });
  return anexos;
}
