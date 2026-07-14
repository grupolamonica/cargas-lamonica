// Endpoints de Gerenciamento de Risco (GR):
//  - DC-234: feed de alertas (read-only, derivado).
//  - DC-236: cofre de credenciais do rastreador — lista mascarada / upsert cifrado /
//    revelar 1 decifrado (+ auditoria). Todos nível advanced.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { parseJsonBody } from "../http-utils.js";
import { fetchGrAlertsReadModel } from "../../../application/operator-admin/use-cases/gr-alerts-read-model.js";
import {
  listRastreadorCredentials,
  upsertRastreadorCredential,
  revealRastreadorCredential,
} from "../../../application/operator-admin/use-cases/rastreador-credentials.js";
import {
  rastreadorCredentialUpsertSchema,
  rastreadorCredentialRevealSchema,
} from "../schemas/rastreador-credentials-schemas.js";

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

const RASTREADOR_ADVANCED_MSG =
  "Apenas operadores com acesso avançado podem gerenciar as credenciais do rastreador.";

/** GET /api/operator/gr/rastreador-credenciais — lista mascarada (sem senha) */
export async function resolveListRastreadorCredentialsResponse(request) {
  return withOperatorSession(request, "gr-rastreador-list", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, "advanced", RASTREADOR_ADVANCED_MSG);
    return listRastreadorCredentials({ correlationId });
  });
}

/** PUT /api/operator/gr/rastreador-credenciais — upsert (cifra a senha) */
export async function resolveUpsertRastreadorCredentialResponse(request) {
  return withOperatorSession(
    request,
    "gr-rastreador-upsert",
    async ({ correlationId, requestIp, operatorId, user }) => {
      assertOperatorAccessLevel(user, "advanced", RASTREADOR_ADVANCED_MSG);
      const body = rastreadorCredentialUpsertSchema.parse(await parseJsonBody(request));
      return upsertRastreadorCredential({ ...body, operatorId, requestIp, correlationId });
    },
  );
}

/** POST /api/operator/gr/rastreador-credenciais/revelar — decifra 1 + registra no audit */
export async function resolveRevealRastreadorCredentialResponse(request) {
  return withOperatorSession(
    request,
    "gr-rastreador-reveal",
    async ({ correlationId, requestIp, operatorId, user }) => {
      assertOperatorAccessLevel(user, "advanced", RASTREADOR_ADVANCED_MSG);
      const { horsePlate } = rastreadorCredentialRevealSchema.parse(await parseJsonBody(request));
      return revealRastreadorCredential({ horsePlate, operatorId, requestIp, correlationId });
    },
  );
}
