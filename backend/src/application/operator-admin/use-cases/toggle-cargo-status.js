import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { buildAuditChanges } from "../../../domain/operator-admin/audit-diff.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { cascadeCancelFromCarga } from "../../cargas-casadas/use-cases/cascade-cancel-from-carga.js";
import { MANUAL_CARGO_STATUSES, assertCargoOwnership, findCargoById } from "./_shared.js";

export async function toggleOperatorCargoStatus({ cargoId, operatorId, operatorAccessLevel, requestIp, correlationId }) {
  // Caminho 1 — carga pertence a pacote (Phase 10 D-05 cascade reverso):
  //   "Desativar" uma carga de pacote quebra a viagem inteira. Aplica-se cascade
  //   cancel (pacote + irmas -> cancelado/CANCELLED + claims ativos -> REJECTED)
  //   em transacao unica.
  //
  // Caminho 2 — carga avulsa (viagem_id IS NULL): toggle OPEN <-> DRAFT como antes.
  //
  // Pre-check fora da transacao principal e seguro porque o cascade reabre transacao
  // propria com lock pessimista; toggle simples (avulsa) usa withPgTransaction abaixo.
  const cargoPreview = await (
    await import("../../../infrastructure/pg/postgres.js")
  ).withPgClient(async (client) => findCargoById(client, cargoId, { lock: false }));

  if (!cargoPreview) {
    throw new NotFoundError("Carga nao encontrada.");
  }
  assertCargoOwnership(cargoPreview, operatorId, { accessLevel: operatorAccessLevel });

  if (cargoPreview.viagem_id) {
    // Cascade reverso D-05.
    const cascadeResult = await cascadeCancelFromCarga({
      cargaId: cargoId,
      operatorId,
      reason: "OPERATOR_TOGGLED_CARGA_IN_PACOTE",
      requestIp,
      correlationId,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        cascade: true,
        pacoteId: cascadeResult.pacoteId,
        cancelledCargaIds: cascadeResult.cancelledCargaIds,
        invalidatedClaimIds: cascadeResult.invalidatedClaimIds,
        alreadyCancelled: cascadeResult.alreadyCancelled ?? false,
        meta: { correlationId },
      },
    };
  }

  // Caminho 2 — fluxo avulsa preservado (backward-compat).
  return withPgTransaction(async (client) => {
    const cargo = await findCargoById(client, cargoId, { lock: true });

    if (!cargo) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    assertCargoOwnership(cargo, operatorId, { accessLevel: operatorAccessLevel });

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
      metadata: {
        previousStatus: cargo.status,
        nextStatus,
        changes: buildAuditChanges(
          { status: cargo.status },
          { status: nextStatus },
          [{ key: "status", label: "Status" }],
        ),
      },
    });

    return {
      statusCode: 200,
      payload: { ok: true, status: nextStatus, meta: { correlationId } },
    };
  });
}
