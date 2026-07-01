import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { MANUAL_CARGO_STATUSES, assertCargoOwnership, findCargoById } from "./_shared.js";
import { PACOTE_STATUS, PACOTE_STATUS_EDITAVEIS } from "../../../domain/cargas-casadas/constants.js";
import { bumpPacoteVersion, selectPacoteForUpdate } from "../../cargas-casadas/use-cases/_shared.js";
import { invalidatePendingClaimsForPacote } from "../../cargas-casadas/use-cases/invalidate-pending-claims.js";

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

    // Carga vinculada a pacote — o que fazer depende do status do pacote:
    //  - reservado / em_andamento: motorista envolvido → bloqueia (cancele o pacote antes).
    //  - rascunho / publicado (editaveis): destaca a carga do pacote, ressequencia as
    //    restantes (1..N) e, se publicado, bump version + invalida candidaturas pendentes
    //    (espelha removeCargaFromPacote — Phase 10 D-05/D-06).
    //  - concluido / cancelado (terminal): exclusao livre, sem cascade.
    let pacoteEditavel = null;
    if (cargo.viagem_id) {
      const pacote = await selectPacoteForUpdate(client, cargo.viagem_id);

      if (
        pacote.status === PACOTE_STATUS.RESERVADO ||
        pacote.status === PACOTE_STATUS.EM_ANDAMENTO
      ) {
        throw new ConflictError(
          "Carga pertence a pacote reservado ou em andamento — cancele o pacote antes de excluir.",
          {
            code: "carga_em_pacote_ativo",
            cargoId,
            pacoteId: cargo.viagem_id,
            pacoteStatus: pacote.status,
          },
        );
      }

      if (PACOTE_STATUS_EDITAVEIS.includes(pacote.status)) {
        pacoteEditavel = pacote;
      }
    }

    await client.query(`DELETE FROM public.cargas WHERE id = $1`, [cargoId]);

    // Cascade em pacote editavel: ressequencia restantes; se publicado, bump version
    // + invalida candidaturas pendentes (mesma logica de removeCargaFromPacote).
    if (pacoteEditavel) {
      const { rows: restantes } = await client.query(
        `SELECT id FROM public.cargas
          WHERE viagem_id = $1
          ORDER BY ordem_viagem ASC NULLS LAST, id ASC
          FOR UPDATE`,
        [pacoteEditavel.id],
      );

      for (let index = 0; index < restantes.length; index += 1) {
        await client.query(
          `UPDATE public.cargas SET ordem_viagem = $2, updated_at = now() WHERE id = $1`,
          [restantes[index].id, index + 1],
        );
      }

      if (pacoteEditavel.status === PACOTE_STATUS.PUBLICADO) {
        await bumpPacoteVersion(client, pacoteEditavel.id);
        await invalidatePendingClaimsForPacote(client, pacoteEditavel.id, "PACOTE_VERSION_BUMPED");
      }
    }

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
      metadata: {
        previousStatus: cargo.status,
        viagemId: cargo.viagem_id ?? null,
        pacoteCascaded: Boolean(pacoteEditavel),
      },
    });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  });
}
