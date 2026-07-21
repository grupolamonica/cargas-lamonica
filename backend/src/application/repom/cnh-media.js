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

// ─── Rate limit da CNH (denial-of-wallet) ──────────────────────────────────────
// O caminho da CNH é o MAIS caro (download + OCR pago + upload) e o número do
// Repom é PÚBLICO/sem auth do remetente — mesmo motivo do freio do agente. Sem
// isto, um script mandando N fotos distintas dispara N OCRs pagos. Limita por
// telefone (janela deslizante) + teto global/hora. Estourou → o motor responde
// "aguarde" e NÃO dispara o pipeline. Process-local (worker single-instance).
function parsePositiveIntEnv(name, fallbackValue) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackValue;
}

const CNH_MAX_PER_PHONE = parsePositiveIntEnv("REPOM_CNH_MAX_PER_PHONE", 6);
const CNH_WINDOW_MS = parsePositiveIntEnv("REPOM_CNH_WINDOW_MS", 10 * 60 * 1000);
const CNH_MAX_GLOBAL_HOUR = parsePositiveIntEnv("REPOM_CNH_MAX_GLOBAL_HOUR", 200);

const cnhPhoneHits = new Map(); // phone(dígitos) -> timestamps[]
let cnhGlobalHits = []; // timestamps

function pruneAndCount(arr, windowMs, now) {
  const cutoff = now - windowMs;
  while (arr.length && arr[0] <= cutoff) arr.shift();
  return arr.length;
}

/** Reserva UMA rodada de OCR de CNH sob os limites; false = estourou → usar msg de espera. */
export function tryReserveCnhCall(phone) {
  const now = Date.now();
  if (pruneAndCount(cnhGlobalHits, 60 * 60 * 1000, now) >= CNH_MAX_GLOBAL_HOUR) return false;
  const key = String(phone || "").replace(/\D/g, "") || "unknown";
  const arr = cnhPhoneHits.get(key) || [];
  if (pruneAndCount(arr, CNH_WINDOW_MS, now) >= CNH_MAX_PER_PHONE) {
    cnhPhoneHits.set(key, arr);
    return false;
  }
  arr.push(now);
  cnhPhoneHits.set(key, arr);
  cnhGlobalHits.push(now);
  return true;
}

export function resetRepomCnhRateLimitForTests() {
  cnhPhoneHits.clear();
  cnhGlobalHits = [];
}

/**
 * Estaciona uma mídia do Repom no Storage (bucket cadastro-drafts, ownerKey = CPF)
 * em UM slot da allowlist (motorista_cnh | motorista_selfie_cnh | motorista_comprovante).
 * Reusa a validação (MIME/tamanho/limpeza de slot) do uploadDraftFile do wizard.
 * Não decide nada do fluxo — só guarda e devolve o path.
 *
 * @returns {Promise<{ok:boolean, storagePath?:string, sha256?:string, reason?:string, statusCode?:number}>}
 */
export async function stageRepomMedia({ cpf, base64, mimetype, slot, correlationId } = {}) {
  const digits = String(cpf || "").replace(/\D/g, "");
  if (digits.length !== 11) return { ok: false, reason: "invalid_cpf" };
  if (!slot) return { ok: false, reason: "invalid_slot" };
  if (!base64) return { ok: false, reason: "empty_media" };

  const file = Buffer.from(base64, "base64");
  if (!file.length) return { ok: false, reason: "empty_media" };

  const res = await uploadDraftFile({
    ownerKey: digits,
    cargaId: REPOM_CARGA_SENTINEL,
    slot,
    file,
    size: file.length,
    contentType: String(mimetype || "").toLowerCase(),
    originalFilename: slot,
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

/** Atalho da CNH (slot motorista_cnh) — mantém a assinatura usada na Fase 3b. */
export async function stageCnhMedia({ cpf, base64, mimetype, correlationId } = {}) {
  return stageRepomMedia({ cpf, base64, mimetype, slot: CNH_SLOT, correlationId });
}
