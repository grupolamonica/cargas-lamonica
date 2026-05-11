import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { LoadClaimServiceError, NotFoundError } from "../../../domain/load-claims/errors.js";

// Atrela uma rota a um cliente. Modelo 1:N — uma rota pertence a no máximo
// um cliente. Se a rota já tem outro cliente, transferimos o vínculo
// (UPDATE) e retornamos transferred_from no payload para a UI poder
// avisar o operador. Operação atômica via UPDATE com retorno do estado anterior.
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

    // Trava a rota e captura cliente atual antes do UPDATE.
    const rotaRow = await client.query(
      `SELECT id, ativa, cliente_id FROM public.rotas WHERE id = $1 FOR UPDATE`,
      [rotaId],
    );
    if (rotaRow.rowCount === 0) {
      throw new NotFoundError(`Rota ${rotaId} nao encontrada.`, "ROTA_NOT_FOUND");
    }
    const rotaAtual = rotaRow.rows[0];
    if (rotaAtual.ativa === false) {
      throw new LoadClaimServiceError(
        "Rota inativa nao pode ser atrelada a cliente.",
        "ROTA_INATIVA",
        409,
      );
    }

    const previousClienteId = rotaAtual.cliente_id ?? null;
    const alreadyAttached = previousClienteId === clienteId;
    const transferred = previousClienteId !== null && previousClienteId !== clienteId;

    if (!alreadyAttached) {
      await client.query(
        `UPDATE public.rotas SET cliente_id = $1, updated_at = now() WHERE id = $2`,
        [clienteId, rotaId],
      );
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.rota_cliente.attached",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "rota",
      resourceId: rotaId,
      action: "attach",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        clienteId,
        previousClienteId,
        transferred,
        alreadyAttached,
      },
    });

    return {
      statusCode: alreadyAttached ? 200 : 201,
      payload: {
        cliente_id: clienteId,
        rota_id: rotaId,
        previous_cliente_id: previousClienteId,
        transferred,
        already_attached: alreadyAttached,
        meta: { correlationId },
      },
    };
  });
}
