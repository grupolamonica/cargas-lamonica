import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { LoadClaimServiceError, NotFoundError } from "../../../domain/load-claims/errors.js";

// Atrela uma rota a um cliente. Idempotente — UNIQUE (cliente_id, rota_id)
// no banco; ON CONFLICT DO NOTHING para que chamadas repetidas não falhem.
export async function attachClienteRota({
  clienteId,
  rotaId,
  operatorId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    // Valida cliente
    const clienteRow = await client.query(
      `SELECT id FROM public.clientes WHERE id = $1 LIMIT 1`,
      [clienteId],
    );
    if (clienteRow.rowCount === 0) {
      throw new NotFoundError(`Cliente ${clienteId} nao encontrado.`, "CLIENTE_NOT_FOUND");
    }

    // Valida rota
    const rotaRow = await client.query(
      `SELECT id, ativa FROM public.rotas WHERE id = $1 LIMIT 1`,
      [rotaId],
    );
    if (rotaRow.rowCount === 0) {
      throw new NotFoundError(`Rota ${rotaId} nao encontrada.`, "ROTA_NOT_FOUND");
    }
    if (rotaRow.rows[0].ativa === false) {
      throw new LoadClaimServiceError(
        "Rota inativa nao pode ser atrelada a cliente.",
        "ROTA_INATIVA",
        409,
      );
    }

    const result = await client.query(
      `INSERT INTO public.cliente_rotas (cliente_id, rota_id)
       VALUES ($1, $2)
       ON CONFLICT (cliente_id, rota_id) DO NOTHING
       RETURNING id, created_at`,
      [clienteId, rotaId],
    );

    const created = result.rowCount > 0;
    const link = created ? result.rows[0] : null;

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente_rota.attached",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente_rota",
      resourceId: clienteId,
      action: "attach",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { rotaId, alreadyExisted: !created },
    });

    return {
      statusCode: created ? 201 : 200,
      payload: {
        cliente_id: clienteId,
        rota_id: rotaId,
        link_id: link?.id ?? null,
        created_at: link?.created_at ?? null,
        already_existed: !created,
        meta: { correlationId },
      },
    };
  });
}
