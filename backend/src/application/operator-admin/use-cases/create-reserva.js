import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";

/**
 * Cria uma reserva (standby) de motorista para uma rota (origem → destino) no
 * Monitor. Escreve em public.monitor_reservas via owner (bypassa RLS).
 *
 * Idempotência: se já existe uma reserva ativa da MESMA rota (origem+destino
 * trimados) para o MESMO motorista (normalizado lower+trim), retorna a existente
 * sem inserir duplicata — evita fila de standbys iguais em cliques repetidos.
 *
 * @param {{ motorista: string, cavalo?: string, carreta?: string, origem: string, destino: string, operatorId: string, requestIp?: string, correlationId?: string }} args
 */
export async function createReserva({ motorista, cavalo, carreta, origem, destino, operatorId, requestIp, correlationId }) {
  const nome = (motorista ?? "").toString().trim();
  if (!nome) {
    throw new ValidationError("Informe o motorista da reserva.");
  }
  const org = (origem ?? "").toString().trim();
  const dst = (destino ?? "").toString().trim();
  if (!org || !dst) {
    throw new ValidationError("Rota (origem e destino) é obrigatória.");
  }

  const cav = (cavalo ?? "").toString().trim();
  const car = (carreta ?? "").toString().trim();

  const { id } = await withPgTransaction(async (client) => {
    // Idempotência: reserva ativa da mesma rota + mesmo motorista (normalizado).
    const { rows: existing } = await client.query(
      `
        SELECT id
        FROM public.monitor_reservas
        WHERE active = true
          AND btrim(origem) = $1
          AND btrim(destino) = $2
          AND lower(btrim(motorista)) = $3
        LIMIT 1
      `,
      [org, dst, nome.toLowerCase()],
    );
    if (existing.length > 0) {
      return { id: existing[0].id };
    }

    const routeKey = `${org}→${dst}`;
    const { rows: inserted } = await client.query(
      `
        INSERT INTO public.monitor_reservas
          (motorista, cavalo, carreta, origem, destino, route_key, status, active, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, 'RESERVA', true, $7)
        RETURNING id
      `,
      [nome, cav, car, org, dst, routeKey, operatorId],
    );
    const newId = inserted[0].id;

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.reserva_created",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "reserva",
      resourceId: newId,
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { motorista: nome, origem: org, destino: dst },
    });

    return { id: newId };
  });

  return {
    statusCode: 200,
    payload: { ok: true, id, meta: { correlationId } },
  };
}
