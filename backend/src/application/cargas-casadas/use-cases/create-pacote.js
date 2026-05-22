import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { PACOTE_STATUS } from "../../../domain/cargas-casadas/constants.js";
import { auditPacoteEvent } from "./_shared.js";

/**
 * Cria um novo pacote em status='rascunho'.
 * - valor_total opcional (operador pode preencher depois via updatePacote).
 * - version inicia em 1.
 */
export async function createPacote({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const valorTotal = typeof payload?.valor_total === "number" ? payload.valor_total : null;

    const { rows } = await client.query(
      `INSERT INTO public.cargas_casadas (status, valor_total, version, created_by)
       VALUES ($1, $2, 1, $3)
       RETURNING id, status, valor_total, version, created_at`,
      [PACOTE_STATUS.RASCUNHO, valorTotal, operatorId || null],
    );

    const pacote = rows[0];

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.created",
      actorUserId: operatorId,
      pacoteId: pacote.id,
      action: "create",
      requestIp,
      correlationId,
      metadata: { valor_total: valorTotal },
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        pacote: {
          id: pacote.id,
          status: pacote.status,
          valor_total: pacote.valor_total !== null ? Number(pacote.valor_total) : null,
          version: pacote.version,
          created_at: pacote.created_at,
        },
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
