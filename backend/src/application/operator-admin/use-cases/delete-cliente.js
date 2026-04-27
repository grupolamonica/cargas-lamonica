import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";

export async function deleteOperatorCliente({ clienteId, operatorId, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const dependencyCheck = await client.query(
      `SELECT COUNT(*)::int AS load_count FROM public.cargas WHERE cliente_id = $1`,
      [clienteId],
    );

    if ((dependencyCheck.rows[0]?.load_count || 0) > 0) {
      throw new ConflictError("Nao e seguro excluir um embarcador que ainda possui cargas vinculadas.", {
        code: "CLIENTE_HAS_CARGAS",
      });
    }

    const { rowCount } = await client.query(
      `DELETE FROM public.clientes WHERE id = $1`,
      [clienteId],
    );

    if (!rowCount) {
      throw new NotFoundError("Embarcador nao encontrado.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      resourceId: clienteId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {},
    });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  });
}
