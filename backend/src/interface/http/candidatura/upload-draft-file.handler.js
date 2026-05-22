import "../../../infrastructure/config/load-env.js";

import { ZodError } from "zod";

import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { requireDriverSession } from "../../../application/load-claims/auth.js";
import { uploadDraftFile } from "../../../application/candidatura/use-cases/upload-draft-file.js";
import {
  getAuthorizationHeader,
  getCorrelationId,
  getRequestIp,
} from "../http-utils.js";
import { uploadDraftFileSchema } from "../schemas/candidatura-schemas.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";

/**
 * POST /api/cadastro/upload-draft-file (multipart/form-data).
 *
 * Body multipart:
 *   file:    binario (1 file, max 8MB) — multer.memoryStorage popula req.file
 *   cargaId: UUID da carga
 *   slot:    enum VALID_DRAFT_SLOTS (ver candidatura-schemas.js)
 *   cpf:     OPCIONAL (11 digitos) — exigido quando sem session driver
 *
 * Auth: driver session via Bearer (preferida) OU CPF no body (anonimo).
 *
 * Resposta 200: { storage_path, signed_url, slot, filename, size, content_type, expires_at }.
 */
export async function resolveUploadDraftFileResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  // ─── Multer file presence ─────────────────────────────────────────────
  if (!request.file || !Buffer.isBuffer(request.file.buffer)) {
    return {
      statusCode: 400,
      payload: {
        error: "FILE_REQUIRED",
        message: "Arquivo obrigatorio (multipart field 'file').",
        meta: { correlationId },
      },
    };
  }

  // ─── Auth: opcional ───────────────────────────────────────────────────
  let session = null;
  try {
    session = await requireDriverSession(getAuthorizationHeader(request));
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return {
        statusCode: 403,
        payload: {
          error: "Forbidden",
          message: err.message,
          meta: { correlationId },
        },
      };
    }
    // UnauthorizedError -> segue como anonimo (precisara CPF abaixo).
    if (!(err instanceof UnauthorizedError)) {
      throw err;
    }
  }

  // ─── Zod (cargaId, slot, cpf optional) ────────────────────────────────
  let parsedInput;
  try {
    parsedInput = uploadDraftFileSchema.parse({
      cargaId: request.body?.cargaId,
      slot: request.body?.slot,
      cpf: request.body?.cpf || undefined,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return zodErrorToHttpResponse(err, correlationId);
    }
    throw err;
  }

  // ─── Resolve ownerKey (session.user.id ou cpf anonimo) ────────────────
  let ownerKey = session?.user?.id ?? null;
  if (!ownerKey) {
    if (!parsedInput.cpf) {
      return {
        statusCode: 401,
        payload: {
          error: "Unauthorized",
          message:
            "Envie um Bearer token de driver OU informe o cpf no body (fluxo publico).",
          meta: { correlationId },
        },
      };
    }
    ownerKey = parsedInput.cpf;
  }

  // ─── Use case ─────────────────────────────────────────────────────────
  try {
    return await uploadDraftFile({
      ownerKey,
      cargaId: parsedInput.cargaId,
      slot: parsedInput.slot,
      file: request.file.buffer,
      size: request.file.size,
      contentType: request.file.mimetype,
      originalFilename: request.file.originalname,
      requestIp,
      correlationId,
    });
  } catch (err) {
    console.error("[candidatura.upload-draft-file]", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      statusCode: 500,
      payload: {
        error: "InternalError",
        message: "Nao foi possivel salvar o arquivo agora. Tente novamente.",
        meta: { correlationId },
      },
    };
  }
}
