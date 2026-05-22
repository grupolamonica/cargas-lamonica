// backend/src/interface/http/upload-middleware.js
// Multer config minimal — memory storage (req.file.buffer), limites alinhados
// ao bucket `cadastro-drafts` (8MB, MIME allowlist).
//
// Usado em: POST /api/cadastro/upload-draft-file (plan 08 PLAN-DRAFT-FILES).
//
// Memory storage: arquivo passa direto pra Supabase Storage — nao toca FS local.
// fileFilter rejeita MIME desconhecido ANTES de buffer ser construido.

import multer from "multer";

import { DRAFT_FILE_MAX_BYTES } from "../../application/candidatura/use-cases/upload-draft-file.js";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export const draftFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DRAFT_FILE_MAX_BYTES,
    files: 1,
    parts: 16, // file + body fields (cargaId, slot, cpf)
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      // Sinaliza UNSUPPORTED_TYPE para o handler reverter em 415.
      const err = new Error("UNSUPPORTED_TYPE");
      err.code = "UNSUPPORTED_TYPE";
      return cb(err);
    }
    cb(null, true);
  },
});
