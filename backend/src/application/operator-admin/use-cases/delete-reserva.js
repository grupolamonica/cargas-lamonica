import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/**
 * Remove (soft-delete) uma reserva (standby) ativa do Monitor. NUNCA apaga o
 * registro — apenas marca active=false, preservando histórico/auditoria.
 *
 * @param {{ reservaId: string, operatorId: string, requestIp?: string, correlationId?: string }} args
 */
export async function deleteReserva({ reservaId, operatorId, requestIp, correlationId }) {
  await withPgTransaction(async (client) => {
    const { rowCount } = await client.query(
      `
        UPDATE public.monitor_reservas
        SET active = false, updated_at = now()
        WHERE id = $1 AND active = true
        RETURNING id
      `,
      [reservaId],
    );
    if (rowCount === 0) {
      throw new NotFoundError("Reserva não encontrada ou já removida.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.reserva_deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "reserva",
      resourceId: reservaId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {},
    });
  });

  return {
    statusCode: 200,
    payload: { ok: true, meta: { correlationId } },
  };
}
