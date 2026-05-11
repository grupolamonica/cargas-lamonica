import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

// Desatrela uma rota de um cliente. Modelo 1:N — apenas zera cliente_id
// se a rota atualmente pertence ao cliente passado (proteção contra
// race condition: se outro operador transferiu a rota, não desfazemos).
// Idempotente — se a rota já está sem cliente OU pertence a outro,
// retornamos removed=false sem erro.
export async function detachClienteRota({
  clienteId,
  rotaId,
  operatorId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const result = await client.query(
      `UPDATE public.rotas
          SET cliente_id = NULL, updated_at = now()
        WHERE id = $1 AND cliente_id = $2
        RETURNING id`,
      [rotaId, clienteId],
    );

    const removed = result.rowCount > 0;

    await insertSecurityAuditEvent(client, {
      eventType: "operator.rota_cliente.detached",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "rota",
      resourceId: rotaId,
      action: "detach",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { clienteId, removed },
    });

    return {
      statusCode: 200,
      payload: {
        cliente_id: clienteId,
        rota_id: rotaId,
        removed,
        meta: { correlationId },
      },
    };
  });
}
