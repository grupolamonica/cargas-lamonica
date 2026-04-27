import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { MANUAL_CARGO_STATUSES, assertCargoOwnership, findCargoById } from "./_shared.js";

export async function deleteOperatorCargo({ cargoId, operatorId, operatorAccessLevel, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const cargo = await findCargoById(client, cargoId, { lock: true });

    if (!cargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    assertCargoOwnership(cargo, operatorId, { accessLevel: operatorAccessLevel });

    if (!MANUAL_CARGO_STATUSES.has(cargo.status)) {
      throw new ConflictError("Nao e seguro excluir cargas controladas pelo fluxo operacional.", {
        code: "CARGO_DELETE_BLOCKED",
      });
    }

    await client.query(`DELETE FROM public.cargas WHERE id = $1`, [cargoId]);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { previousStatus: cargo.status },
    });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  });
}
