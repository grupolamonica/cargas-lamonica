// Anexar selfie (segurando a CNH) a um cadastro que concluiu SEM o documento.
//
// Contexto: a selfie é obrigatória no wizard (Step A) e no submit
// (required-documents.js), MAS quando o Step A é pulado (motorista já conhecido/
// mesclado) nenhum dos dois a cobra — o cadastro conclui sem selfie e cai na aba
// "Dados incompletos" (pending-registration-problemas.js: "Selfie com a CNH não
// anexada"). Este use-case dá ao operador o meio de completar esse cadastro:
// sobe a selfie pro Storage (pasta escopada por CPF+carga do PRÓPRIO cadastro —
// NUNCA por caminho vindo do cliente, evitando clobber/traversal) e grava
// `dados.motorista.selfie_cnh_url`.
//
// Reusa uploadDraftFile (mesmo bucket/slot do wizard: `motorista_selfie_cnh`),
// que já remove o arquivo antigo do mesmo slot — idempotente por natureza.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { uploadDraftFile } from "../../candidatura/use-cases/upload-draft-file.js";

const SELFIE_SLOT = "motorista_selfie_cnh";

function digitsOnly(v) {
  return String(v ?? "").replace(/\D/g, "");
}

/**
 * @param {object} args
 * @param {string}  args.id               ID do pending_driver_registration.
 * @param {Buffer}  args.file             Buffer do arquivo (multer memoryStorage).
 * @param {number}  args.size             Tamanho em bytes.
 * @param {string}  args.contentType      MIME validado pelo multer.
 * @param {string}  [args.originalFilename]
 * @param {string}  [args.correlationId]
 * @param {string}  [args.requestIp]
 * @param {string}  [args.operatorId]
 * @param {Function} [args.runWithClient] Injetável p/ teste (default withPgClient).
 * @param {Function} [args.uploadFn]      Injetável p/ teste (default uploadDraftFile).
 * @param {Function} [args.auditFn]       Injetável p/ teste (default insertSecurityAuditEvent).
 * @param {object}   [args.supabaseClient] Injetável p/ teste (repassado ao uploadFn).
 * @returns {Promise<{statusCode:number, payload:object}>}
 */
export async function anexarSelfieToCadastro({
  id,
  file,
  size,
  contentType,
  originalFilename,
  correlationId,
  requestIp,
  operatorId,
  runWithClient = withPgClient,
  uploadFn = uploadDraftFile,
  auditFn = insertSecurityAuditEvent,
  supabaseClient,
}) {
  if (!id) {
    return { statusCode: 400, payload: { error: "BadRequest", message: "ID do cadastro é obrigatório.", meta: { correlationId } } };
  }
  if (!Buffer.isBuffer(file)) {
    return { statusCode: 400, payload: { error: "FILE_REQUIRED", message: "Arquivo obrigatório (campo 'file').", meta: { correlationId } } };
  }

  return runWithClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, carga_id, dados FROM public.pending_driver_registrations WHERE id = $1`,
      [id],
    );
    if (!rows.length) {
      return { statusCode: 404, payload: { error: "NotFound", message: "Cadastro não encontrado.", meta: { correlationId } } };
    }

    const row = rows[0];
    const dados = row.dados && typeof row.dados === "object" && !Array.isArray(row.dados) ? row.dados : {};
    const motorista = dados.motorista && typeof dados.motorista === "object" ? dados.motorista : null;
    const cpf = digitsOnly(motorista?.cpf);
    if (!motorista || cpf.length !== 11) {
      return {
        statusCode: 409,
        payload: {
          error: "Conflict",
          message: "Cadastro sem CPF de motorista válido — não é possível escopar o upload da selfie.",
          meta: { correlationId },
        },
      };
    }

    // Pasta escopada pelo CPF do motorista + carga do PRÓPRIO cadastro (fonte:
    // a row do banco, NUNCA o cliente) — mesmo namespace do wizard.
    const ownerKey = cpf;
    const cargaId = row.carga_id || id;

    const uploadResult = await uploadFn({
      ownerKey,
      cargaId,
      slot: SELFIE_SLOT,
      file,
      size,
      contentType,
      originalFilename,
      requestIp,
      correlationId,
      supabaseClient,
    });
    // Propaga erros de upload (413/415/502...) sem tocar no cadastro.
    if (!uploadResult || uploadResult.statusCode !== 200) {
      return uploadResult ?? {
        statusCode: 502,
        payload: { error: "STORAGE_UNAVAILABLE", message: "Falha ao subir a selfie.", meta: { correlationId } },
      };
    }

    const storagePath = uploadResult.payload.storage_path;
    const nextDados = { ...dados, motorista: { ...motorista, selfie_cnh_url: storagePath } };
    await client.query(
      `UPDATE public.pending_driver_registrations SET dados = $1 WHERE id = $2`,
      [JSON.stringify(nextDados), id],
    );

    // Audit best-effort — falha aqui não desfaz o anexo.
    try {
      await auditFn(client, {
        eventType: "operator.cadastro.selfie_anexada",
        actorUserId: operatorId ?? null,
        actorRole: "operator",
        resourceType: "pending_driver_registration",
        resourceId: id,
        action: "anexar_selfie",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { slot: SELFIE_SLOT, storage_path: storagePath },
      });
    } catch {
      /* best-effort */
    }

    return {
      statusCode: 200,
      payload: { ok: true, selfie_cnh_url: storagePath, meta: { correlationId } },
    };
  });
}
