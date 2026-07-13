// Endpoint da aba "Dados incompletos": cadastros pendentes com problema (dado
// faltando / não conforme), cada um com os motivos. Read-only e DERIVADO — não
// muda status de nada no banco.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { fetchPendingClassified } from "../../../application/operator-admin/use-cases/pending-classified-read-model.js";

/** GET /api/operator/cadastros-incompletos?search=&page=&pageSize=&sort=&dir= */
export async function resolveOperatorCadastrosIncompletosResponse(request) {
  return withOperatorSession(request, "read-cadastros-incompletos", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem ver os cadastros com dados incompletos.",
    );
    const query = request.query || {};
    return fetchPendingClassified({
      bucket: "incompletos",
      search: typeof query.search === "string" ? query.search : null,
      page: query.page,
      pageSize: query.pageSize,
      sort: typeof query.sort === "string" ? query.sort : undefined,
      dir: typeof query.dir === "string" ? query.dir : undefined,
      correlationId,
    });
  });
}
