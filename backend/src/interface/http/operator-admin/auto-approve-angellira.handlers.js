// Endpoints do operador para a aprovação automática por vigência no Angellira.
// - GET  /api/operator/settings/auto-approve-angellira        → estado atual
// - PUT  /api/operator/settings/auto-approve-angellira        → liga/desliga o job
// - POST /api/operator/cadastros/auto-approve-angellira/run   → roda uma leva agora
//
// A lógica pesada vive no use-case session-independent (também usado pelo job
// periódico do main.js). Aqui só entra auth + orquestração da resposta.
import { withOperatorSession } from "./handlers.js";
import { assertOperatorAccessLevel } from "../../../application/load-claims/operator-access.js";
import { parseJsonBody } from "../http-utils.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import {
  getAutoApproveSetting,
  setAutoApproveEnabled,
  countPendingWithCpf,
  runAutoApproveAngelliraVigentes,
  isAutoApproveRunning,
} from "../../../application/operator-admin/use-cases/angellira/auto-approve-vigentes.js";

const REQUIRED_LEVEL = "intermediate";

/** GET /api/operator/settings/auto-approve-angellira */
export async function resolveOperatorAutoApproveAngelliraGetResponse(request) {
  return withOperatorSession(request, "auto-approve-angellira-get", async ({ correlationId, user }) => {
    assertOperatorAccessLevel(user, REQUIRED_LEVEL, "Apenas operadores com acesso intermediário ou avançado podem ver esta configuração.");
    const [setting, pendingCount] = await Promise.all([getAutoApproveSetting(), countPendingWithCpf()]);
    return {
      statusCode: 200,
      payload: {
        ok: true,
        enabled: setting.enabled,
        running: isAutoApproveRunning(),
        lastRun: setting.lastRun,
        pendingCount,
        meta: { correlationId },
      },
    };
  });
}

/** PUT /api/operator/settings/auto-approve-angellira  body { enabled: boolean } */
export async function resolveOperatorAutoApproveAngelliraPutResponse(request) {
  return withOperatorSession(request, "auto-approve-angellira-set", async ({ correlationId, operatorId, user }) => {
    assertOperatorAccessLevel(user, REQUIRED_LEVEL, "Apenas operadores com acesso intermediário ou avançado podem alterar esta configuração.");
    let body = {};
    try {
      body = await parseJsonBody(request);
    } catch {
      // body inválido tratado abaixo
    }
    if (typeof body?.enabled !== "boolean") {
      return { statusCode: 400, payload: { error: "BadRequest", message: "Campo 'enabled' (boolean) é obrigatório.", meta: { correlationId } } };
    }
    const result = await setAutoApproveEnabled({ enabled: body.enabled, actorId: operatorId });
    logStructuredEvent("info", "auto-approve-angellira.toggle", { correlationId, operatorId, enabled: result.enabled });
    return { statusCode: 200, payload: { ok: true, enabled: result.enabled, meta: { correlationId } } };
  });
}

/** POST /api/operator/cadastros/auto-approve-angellira/run  body { limit?: number } */
export async function resolveOperatorAutoApproveAngelliraRunResponse(request) {
  return withOperatorSession(request, "auto-approve-angellira-run", async ({ correlationId, operatorId, user }) => {
    assertOperatorAccessLevel(user, REQUIRED_LEVEL, "Apenas operadores com acesso intermediário ou avançado podem rodar a aprovação automática.");
    if (isAutoApproveRunning()) {
      return { statusCode: 409, payload: { error: "AlreadyRunning", message: "Já existe uma execução em andamento. Aguarde ela terminar.", meta: { correlationId } } };
    }
    let body = {};
    try {
      body = await parseJsonBody(request);
    } catch {
      // body opcional
    }
    const limit = Number.isFinite(Number(body?.limit)) ? Number(body.limit) : 50;

    // A consulta ao Angellira leva minutos (N CPFs x ~10s). Dispara em segundo
    // plano e responde 202 na hora; a UI acompanha o progresso via GET.
    runAutoApproveAngelliraVigentes({ limit, apply: true, actorUserId: operatorId, trigger: "manual", correlationId }).catch(
      (err) => logStructuredEvent("error", "auto-approve-angellira.run_failed", { correlationId, message: String(err?.message || err) }),
    );

    return { statusCode: 202, payload: { ok: true, started: true, meta: { correlationId } } };
  });
}
