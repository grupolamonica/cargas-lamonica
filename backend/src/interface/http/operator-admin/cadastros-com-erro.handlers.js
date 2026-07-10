// Endpoint da sub-aba "Com erro" (DC-196): lista os cadastros cujo cadastro
// externo (Angellira/SPX) falhou, com a causa e a ação sugerida. Read-only.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { fetchCadastrosComErro } from "../../../application/operator-admin/use-cases/cadastros-com-erro-read-model.js";

/** GET /api/operator/cadastros-com-erro?origem=&page=&pageSize= */
export async function resolveOperatorCadastrosComErroResponse(request) {
  return withOperatorSession(request, "read-cadastros-com-erro", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem ver os cadastros com erro.",
    );
    const query = request.query || {};
    return fetchCadastrosComErro({
      origem: typeof query.origem === "string" ? query.origem.trim() : null,
      page: query.page,
      pageSize: query.pageSize,
      correlationId,
    });
  });
}
