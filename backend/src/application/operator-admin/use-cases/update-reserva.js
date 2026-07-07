import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";

/**
 * Edita uma reserva (standby) ativa no Monitor — motorista/cavalo/carreta.
 * Update parcial: só sobrescreve o campo quando o argumento foi informado (não
 * undefined). Lock FOR UPDATE para não colidir com um assign-reserva concorrente.
 *
 * @param {{ reservaId: string, motorista?: string, cavalo?: string, carreta?: string, operatorId: string, requestIp?: string, correlationId?: string }} args
 */
export async function updateReserva({ reservaId, motorista, cavalo, carreta, operatorId, requestIp, correlationId }) {
  await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `
        SELECT id, motorista, cavalo, carreta
        FROM public.monitor_reservas
        WHERE id = $1 AND active = true
        FOR UPDATE
      `,
      [reservaId],
    );
    if (rows.length === 0) {
      throw new NotFoundError("Reserva não encontrada ou já utilizada.");
    }
    const current = rows[0];

    let nextMotorista = current.motorista;
    if (motorista !== undefined) {
      const nome = (motorista ?? "").toString().trim();
      if (!nome) {
        throw new ValidationError("Informe o motorista da reserva.");
      }
      nextMotorista = nome;
    }
    const nextCavalo = cavalo !== undefined ? (cavalo ?? "").toString().trim() : current.cavalo;
    const nextCarreta = carreta !== undefined ? (carreta ?? "").toString().trim() : current.carreta;

    await client.query(
      `
        UPDATE public.monitor_reservas
        SET motorista = $2, cavalo = $3, carreta = $4, updated_at = now()
        WHERE id = $1
      `,
      [reservaId, nextMotorista, nextCavalo, nextCarreta],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.reserva_updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "reserva",
      resourceId: reservaId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { motorista: nextMotorista },
    });
  });

  return {
    statusCode: 200,
    payload: { ok: true, id: reservaId, meta: { correlationId } },
  };
}
