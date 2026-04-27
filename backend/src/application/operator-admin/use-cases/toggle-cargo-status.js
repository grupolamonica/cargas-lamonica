import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { MANUAL_CARGO_STATUSES, assertCargoOwnership, findCargoById } from "./_shared.js";

export async function toggleOperatorCargoStatus({ cargoId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const cargo = await findCargoById(client, cargoId, { lock: true });

    if (!cargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    assertCargoOwnership(cargo, operatorId);

    if (!MANUAL_CARGO_STATUSES.has(cargo.status)) {
      throw new ConflictError("Somente cargas abertas ou em rascunho podem ser alteradas manualmente.", {
        code: "CARGO_STATUS_MANAGED_BY_SYSTEM",
      });
    }

    const nextStatus = cargo.status === "OPEN" ? "DRAFT" : "OPEN";

    await client.query(`UPDATE public.cargas SET status = $2 WHERE id = $1`, [cargoId, nextStatus]);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.status_toggled",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "toggle-status",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { previousStatus: cargo.status, nextStatus },
    });

    return {
      statusCode: 200,
      payload: { ok: true, status: nextStatus, meta: { correlationId } },
    };
  });
}
