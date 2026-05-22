import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { MANUAL_CARGO_STATUSES, assertCargoOwnership, findCargoById } from "./_shared.js";

// Status terminais do pacote — delete e permitido se pacote ja esta encerrado.
const PACOTE_STATUS_TERMINAL_OR_DRAFT = new Set(["rascunho", "cancelado", "concluido"]);

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

    // Phase 10 D-05: carga em pacote ativo nao pode ser excluida diretamente.
    // Operador deve cancelar o pacote (via cancelPacote ou cascade) antes.
    if (cargo.viagem_id) {
      const { rows: [pacote] } = await client.query(
        `SELECT status FROM public.cargas_casadas WHERE id = $1`,
        [cargo.viagem_id],
      );
      if (pacote && !PACOTE_STATUS_TERMINAL_OR_DRAFT.has(pacote.status)) {
        throw new ConflictError(
          "Carga pertence a pacote ativo — cancele o pacote antes de excluir.",
          { code: "carga_em_pacote_ativo", cargoId, pacoteId: cargo.viagem_id, pacoteStatus: pacote.status },
        );
      }
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
      metadata: { previousStatus: cargo.status, viagemId: cargo.viagem_id ?? null },
    });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  });
}
