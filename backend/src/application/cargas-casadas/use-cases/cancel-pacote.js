import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import {
  PACOTE_STATUS,
  PACOTE_STATUS_TERMINAL,
} from "../../../domain/cargas-casadas/constants.js";
import { ConflictError } from "../../../domain/load-claims/errors.js";
import {
  auditPacoteEvent,
  buildCancelCascadeCargaUpdateSql,
  rejectActiveClaimsForPacote,
  selectCargasByPacote,
  selectPacoteForUpdate,
} from "./_shared.js";

/**
 * Cancela um pacote — cascade transacional (D-05):
 *  1. UPDATE cargas_casadas SET status='cancelado', version+=1.
 *  2. UPDATE cargas SET status='CANCELLED', limpa reserved_ + booked_ WHERE viagem_id=pacoteId.
 *  3. UPDATE load_claims SET status='REJECTED', reason='PACOTE_CANCELLED' para claims ativos.
 *
 * Bloqueia se pacote ja em status terminal (concluido/cancelado).
 */
export async function cancelPacote({
  operatorId,
  pacoteId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (PACOTE_STATUS_TERMINAL.includes(pacote.status)) {
      throw new ConflictError(
        `Pacote ja em status '${pacote.status}'.`,
        { pacoteId, status: pacote.status, code: "pacote_ja_terminal" },
      );
    }

    const cargasAntes = await selectCargasByPacote(client, pacoteId, { forUpdate: true });

    // 1) Pacote -> 'cancelado'
    const { rows } = await client.query(
      `UPDATE public.cargas_casadas
          SET status = $2, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING id, status, version`,
      [pacoteId, PACOTE_STATUS.CANCELADO],
    );

    // 2) Cargas do pacote -> 'CANCELLED' + reset reserved/booked
    const { rowCount: cargasAfetadas } = await client.query(
      buildCancelCascadeCargaUpdateSql(),
      [pacoteId],
    );

    // 3) load_claims ativos -> 'REJECTED'
    const claimsRejeitados = await rejectActiveClaimsForPacote(client, pacoteId, {
      reason: "PACOTE_CANCELLED",
    });

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.cancelled",
      actorUserId: operatorId,
      pacoteId,
      action: "cancel",
      severity: "warn",
      requestIp,
      correlationId,
      metadata: {
        cargas_afetadas: cargasAfetadas,
        cargas_ids_antes: cargasAntes.map((c) => c.id),
        claims_rejeitados: claimsRejeitados,
        status_antes: pacote.status,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacote: rows[0],
        cargas_afetadas: cargasAfetadas,
        claims_rejeitados: claimsRejeitados,
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
