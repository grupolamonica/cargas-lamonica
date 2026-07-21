/**
 * Repom — Fase 3b (blocos de mídia da CNH). Peças ISOLADAS e testáveis:
 *  - claimMessageOnce: idempotência por message-id (tabela repom_processed_messages).
 *  - sha256Base64: hash do arquivo (dedupe de re-envio; usado no PR de OCR).
 *  - stageCnhMedia: valida + guarda a CNH no Supabase Storage (reusa uploadDraftFile).
 *
 * NÃO baixa a mídia do Evolution nem pluga no fluxo — isso é a etapa de fiação
 * (depende do transporte Baileys são + confirmar o contrato getBase64FromMediaMessage).
 * Aqui tudo é verificável com mocks/pg-mem.
 */

import crypto from "node:crypto";

import { uploadDraftFile } from "../candidatura/use-cases/upload-draft-file.js";

// Segmento de path no bucket para uploads do Repom (não há "carga" no cadastro
// avulso por WhatsApp). Sentinela honesto — nunca um UUID falso.
const REPOM_CARGA_SENTINEL = "repom";
const CNH_SLOT = "motorista_cnh";

/**
 * Registra o processamento de UMA mensagem (idempotente).
 * @returns {Promise<boolean>} true = primeira vez (pode processar); false = já processada.
 */
export async function claimMessageOnce(client, { externalId, phone, kind = "media", fileSha256 = null }) {
  if (!externalId) return true; // sem id não dá pra deduplicar → processa

  // SELECT decide (visto? → pula); INSERT registra. O ON CONFLICT DO NOTHING
  // absorve a corrida (2 entregas simultâneas) sem lançar. Não dependemos do
  // RETURNING do DO NOTHING (semântica que o pg-mem dos testes não honra).
  const existing = await client.query(
    `SELECT 1 FROM public.repom_processed_messages WHERE external_id = $1 LIMIT 1`,
    [externalId],
  );
  if (existing.rows.length > 0) return false;

  await client.query(
    `INSERT INTO public.repom_processed_messages (external_id, phone, kind, file_sha256)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO NOTHING`,
    [externalId, phone || null, kind, fileSha256],
  );
  return true;
}

/** SHA-256 (hex) do conteúdo do arquivo a partir do base64. */
export function sha256Base64(base64) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(String(base64 || ""), "base64"))
    .digest("hex");
}

/**
 * Estaciona a CNH no Storage (bucket cadastro-drafts, slot motorista_cnh,
 * ownerKey = CPF). Reusa a validação (MIME/tamanho/limpeza de slot) do
 * uploadDraftFile do wizard. Não decide nada do fluxo — só guarda e devolve o path.
 *
 * @returns {Promise<{ok:boolean, storagePath?:string, sha256?:string, reason?:string, statusCode?:number}>}
 */
export async function stageCnhMedia({ cpf, base64, mimetype, correlationId } = {}) {
  const digits = String(cpf || "").replace(/\D/g, "");
  if (digits.length !== 11) return { ok: false, reason: "invalid_cpf" };
  if (!base64) return { ok: false, reason: "empty_media" };

  const file = Buffer.from(base64, "base64");
  if (!file.length) return { ok: false, reason: "empty_media" };

  const res = await uploadDraftFile({
    ownerKey: digits,
    cargaId: REPOM_CARGA_SENTINEL,
    slot: CNH_SLOT,
    file,
    size: file.length,
    contentType: String(mimetype || "").toLowerCase(),
    originalFilename: "cnh",
    correlationId,
  });

  if (res?.statusCode === 200) {
    return { ok: true, storagePath: res.payload.storage_path, sha256: sha256Base64(base64) };
  }

  const reasonByCode = {
    400: "invalid_file",
    413: "too_large",
    415: "unsupported_type",
    502: "storage_unavailable",
  };
  return { ok: false, reason: reasonByCode[res?.statusCode] || "upload_failed", statusCode: res?.statusCode ?? null };
}
