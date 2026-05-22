import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { getAdminClient } from "../../load-claims/auth.js";

// ─── Constantes de dominio ───────────────────────────────────────────────────

export const DRAFT_FILE_BUCKET = "cadastro-drafts";
export const DRAFT_FILE_MAX_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * Allowlist de slots aceitos pelo upload. Mantida em sync com:
 *   - frontend OcrUploadTile (estrutura {section}_{type}_{index?})
 *   - schema candidatura.dados (motoristaSchema/cavaloSchema/carretaSchema)
 *
 * 21 slots no total: 3 motorista + 4 cavalo + 8 carretas (até 2) + 2 ANTT
 * cavalo + 4 ANTT carretas (cnh+comprovante × 2 carretas).
 */
export const VALID_DRAFT_SLOTS = new Set([
  "motorista_cnh",
  "motorista_selfie_cnh",
  "motorista_comprovante",
  "cavalo_crlv",
  "cavalo_antt",
  "cavalo_owner_cnh",
  "cavalo_owner_comprovante",
  "carreta_crlv_0",
  "carreta_crlv_1",
  "carreta_antt_0",
  "carreta_antt_1",
  "carreta_owner_cnh_0",
  "carreta_owner_cnh_1",
  "carreta_owner_comprovante_0",
  "carreta_owner_comprovante_1",
  // ANTT titular — proprietario que detem o RNTRC quando diferente do dono
  // do veiculo. Etapa dedicada apos C/E. Adicionado em 2026-05-20.
  "cavalo_antt_owner_cnh",
  "cavalo_antt_owner_comprovante",
  "carreta_antt_owner_cnh_0",
  "carreta_antt_owner_cnh_1",
  "carreta_antt_owner_comprovante_0",
  "carreta_antt_owner_comprovante_1",
]);

/**
 * MIME types permitidos no bucket (espelha allowed_mime_types da migration).
 * Map para extensao usada no path final (timestamp_slot.ext).
 */
const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24h

function maskOwnerKey(ownerKey) {
  const str = String(ownerKey || "");
  if (str.length <= 6) return "***";
  return `${str.slice(0, 4)}***${str.slice(-2)}`;
}

/**
 * Faz upload de um arquivo do wizard para Supabase Storage (bucket privado),
 * remove arquivos antigos do mesmo slot/owner/carga (mantem apenas o ultimo)
 * e devolve signed URL TTL 24h.
 *
 * @param {Object} args
 * @param {string} args.ownerKey   driver_user_id (UUID) OU cpf (11 digitos) para anonimo.
 * @param {string} args.cargaId    UUID da carga (contexto do wizard).
 * @param {string} args.slot       Slot da allowlist VALID_DRAFT_SLOTS.
 * @param {Buffer} args.file       Buffer com o arquivo bruto.
 * @param {number} args.size       Tamanho do arquivo em bytes.
 * @param {string} args.contentType  MIME type validado.
 * @param {string} [args.originalFilename]  Nome original (apenas audit/return).
 * @param {string} [args.requestIp]
 * @param {string} [args.correlationId]
 */
export async function uploadDraftFile({
  ownerKey,
  cargaId,
  slot,
  file,
  size,
  contentType,
  originalFilename,
  requestIp,
  correlationId,
  // Injetable para testes (Supabase admin client mockado).
  supabaseClient,
}) {
  // ─── Validacoes iniciais (defense in depth — handler tambem valida) ────
  if (!VALID_DRAFT_SLOTS.has(slot)) {
    return {
      statusCode: 400,
      payload: {
        error: "INVALID_SLOT",
        message: `Slot '${slot}' nao e aceito. Verifique a allowlist.`,
        meta: { correlationId },
      },
    };
  }

  const ext = MIME_TO_EXT[contentType];
  if (!ext) {
    return {
      statusCode: 415,
      payload: {
        error: "UNSUPPORTED_TYPE",
        message:
          "Tipo de arquivo nao suportado. Use JPEG, PNG, HEIC, HEIF ou PDF.",
        meta: { correlationId },
      },
    };
  }

  if (!Buffer.isBuffer(file)) {
    return {
      statusCode: 400,
      payload: {
        error: "INVALID_FILE",
        message: "Arquivo invalido — esperado buffer.",
        meta: { correlationId },
      },
    };
  }

  if (size > DRAFT_FILE_MAX_BYTES) {
    return {
      statusCode: 413,
      payload: {
        error: "FILE_TOO_LARGE",
        message: `Arquivo excede o limite de ${DRAFT_FILE_MAX_BYTES} bytes (8 MB).`,
        meta: { correlationId },
      },
    };
  }

  const client = supabaseClient || getAdminClient();
  const storage = client.storage.from(DRAFT_FILE_BUCKET);

  const timestamp = Date.now();
  const newPath = `${ownerKey}/${cargaId}/${slot}_${timestamp}.${ext}`;
  const prefix = `${ownerKey}/${cargaId}`;
  const slotMatchPrefix = `${slot}_`;

  // ─── Remove arquivos antigos do mesmo slot (best-effort) ─────────────
  // Lista files do prefix `{ownerKey}/{cargaId}` e filtra por `${slot}_`.
  // Falha aqui NAO bloqueia upload — apenas inflaria storage temporariamente.
  try {
    const { data: existing, error: listError } = await storage.list(prefix, {
      limit: 100,
      offset: 0,
    });
    if (!listError && Array.isArray(existing) && existing.length > 0) {
      const stalePaths = existing
        .filter((entry) => entry?.name && entry.name.startsWith(slotMatchPrefix))
        .map((entry) => `${prefix}/${entry.name}`);
      if (stalePaths.length > 0) {
        const { error: removeError } = await storage.remove(stalePaths);
        if (removeError) {
          console.warn("[candidatura.upload-draft-file.cleanup]", {
            correlationId,
            message: removeError.message || String(removeError),
            stalePathsCount: stalePaths.length,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[candidatura.upload-draft-file.cleanup]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── Upload novo arquivo ──────────────────────────────────────────────
  const { error: uploadError } = await storage.upload(newPath, file, {
    contentType,
    upsert: false,
  });
  if (uploadError) {
    console.error("[candidatura.upload-draft-file.upload_failed]", {
      correlationId,
      slot,
      message: uploadError.message || String(uploadError),
    });
    return {
      statusCode: 502,
      payload: {
        error: "STORAGE_UNAVAILABLE",
        message:
          "Storage indisponivel no momento. Tente reenviar em alguns segundos.",
        meta: { correlationId },
      },
    };
  }

  // ─── Signed URL TTL 24h ───────────────────────────────────────────────
  let signedUrl = null;
  try {
    const { data: signedData, error: signedError } = await storage.createSignedUrl(
      newPath,
      SIGNED_URL_TTL_SECONDS,
    );
    if (signedError) {
      console.warn("[candidatura.upload-draft-file.signed_url_failed]", {
        correlationId,
        message: signedError.message || String(signedError),
      });
    } else {
      signedUrl = signedData?.signedUrl ?? signedData?.signedURL ?? null;
    }
  } catch (err) {
    console.warn("[candidatura.upload-draft-file.signed_url_failed]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

  // ─── Audit event (sem arquivo cru, owner mascarado) ───────────────────
  try {
    await withPgTransaction(async (pgClient) => {
      await insertSecurityAuditEvent(pgClient, {
        eventType: "driver.candidatura.draft_file_uploaded",
        actorUserId: null,
        actorRole: "driver_candidato",
        resourceType: "cadastro_draft_file",
        resourceId: newPath,
        action: "create",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: {
          slot,
          carga_id: cargaId,
          size,
          content_type: contentType,
          owner_masked: maskOwnerKey(ownerKey),
        },
      });
    });
  } catch (err) {
    // Audit falhando NAO bloqueia upload (best-effort).
    console.warn("[candidatura.upload-draft-file.audit_failed]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    statusCode: 200,
    payload: {
      storage_path: newPath,
      signed_url: signedUrl,
      slot,
      filename: originalFilename || `${slot}.${ext}`,
      size,
      content_type: contentType,
      expires_at: expiresAt,
      meta: { correlationId },
    },
  };
}
