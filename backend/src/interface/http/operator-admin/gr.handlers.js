// Endpoint do feed de alertas de Gerenciamento de Risco (GR) — card DC-234.
// Read-only e DERIVADO: varre motoristas/veículos e devolve os alertas de
// vigência/estado + o summary (KPIs). Não altera nada no banco.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { fetchGrAlertsReadModel } from "../../../application/operator-admin/use-cases/gr-alerts-read-model.js";

/** GET /api/operator/gr/alertas */
export async function resolveOperatorGrAlertasResponse(request) {
  return withOperatorSession(request, "read-gr-alertas", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(
      user,
      "intermediate",
      "Apenas operadores com acesso intermediário ou avançado podem ver os alertas de gerenciamento de risco.",
    );
    return fetchGrAlertsReadModel({ correlationId });
  });
}
