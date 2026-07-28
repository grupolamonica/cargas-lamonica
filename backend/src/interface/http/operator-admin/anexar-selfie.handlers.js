// POST /api/operator/cadastros/:id/anexar-selfie  (multipart/form-data)
//
// Permite ao operador anexar a selfie (segurando a CNH) a um cadastro que foi
// concluído SEM ela (aparece em "Dados incompletos"). O arquivo vem via multer
// (memoryStorage → request.file); a pasta de destino é escopada pelo CPF/carga
// do PRÓPRIO cadastro no use-case — nada de caminho vindo do cliente.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { getQueryParam } from "../http-utils.js";
import { anexarSelfieToCadastro } from "../../../application/operator-admin/use-cases/anexar-selfie.js";

export async function resolveOperatorAnexarSelfieResponse(request) {
  return withOperatorSession(request, "anexar-selfie", async ({ correlationId, requestIp, operatorId, user }) => {
    assertOperatorAccessLevel(user, "intermediate", "Acesso intermediário necessário para anexar documentos.");
    const id = getQueryParam(request, "id");
    if (!request.file || !Buffer.isBuffer(request.file.buffer)) {
      return {
        statusCode: 400,
        payload: { error: "FILE_REQUIRED", message: "Arquivo obrigatório (campo multipart 'file').", meta: { correlationId } },
      };
    }
    return anexarSelfieToCadastro({
      id,
      file: request.file.buffer,
      size: request.file.size,
      contentType: request.file.mimetype,
      originalFilename: request.file.originalname,
      correlationId,
      requestIp,
      operatorId,
    });
  });
}
