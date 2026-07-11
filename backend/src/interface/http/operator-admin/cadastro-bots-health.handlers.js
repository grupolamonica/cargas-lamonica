// Endpoint da saúde dos robôs de cadastro externo (DC-222 AC6). Read-only:
// diz ao painel quais sidecars (Angellira/SPX/Dossiê) estão fora do ar.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { getCadastroBotsHealth } from "../../../application/operator-admin/use-cases/cadastro-bots-health.js";

/** GET /api/operator/cadastro-bots/health */
export async function resolveOperatorCadastroBotsHealthResponse(request) {
  return withOperatorSession(request, "read-cadastro-bots-health", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem ver a saúde dos robôs de cadastro.",
    );
    return getCadastroBotsHealth({ correlationId });
  });
}
