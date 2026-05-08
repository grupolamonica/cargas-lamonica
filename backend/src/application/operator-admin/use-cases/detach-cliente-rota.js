import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

// Desatrela uma rota de um cliente. Idempotente — não falha se o link já
// não existe (DELETE retorna 0 rows). Auditoria registra distinção.
export async function detachClienteRota({
  clienteId,
  rotaId,
  operatorId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const result = await client.query(
      `DELETE FROM public.cliente_rotas
       WHERE cliente_id = $1 AND rota_id = $2`,
      [clienteId, rotaId],
    );

    const removed = result.rowCount > 0;

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente_rota.detached",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente_rota",
      resourceId: clienteId,
      action: "detach",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { rotaId, removed },
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
