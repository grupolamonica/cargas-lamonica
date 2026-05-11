import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

/**
 * Persiste o cadastro completo do motorista como pendente para revisão do operador.
 *
 * @param {object} opts
 * @param {string} opts.id_cadastro  - ID de pasta do backend FastAPI (ex: "antonio-2025-05-06")
 * @param {object} opts.dados        - Payload completo do formulário (motorista, cavalo, carreta…)
 * @param {string} [opts.requestIp]  - IP do solicitante (auditoria)
 * @param {string} [opts.correlationId] - Correlation ID da requisição
 * @returns {{ statusCode: number, payload: object }}
 */
export async function finalizarCadastro({ id_cadastro, dados, requestIp, correlationId }) {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        INSERT INTO public.pending_driver_registrations (id_cadastro, dados)
        VALUES ($1, $2)
        RETURNING id
      `,
      [id_cadastro, JSON.stringify(dados)],
    );

    const id = result.rows[0]?.id;

    await insertSecurityAuditEvent(client, {
      eventType: "public.cadastro.submitted",
      actorUserId: null,
      actorRole: "public",
      resourceType: "pending_driver_registration",
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { id, id_cadastro, nomeMotorista: dados?.motorista?.nome || null },
    });

    return {
      statusCode: 201,
      payload: { ok: true, id, meta: { correlationId } },
    };
  });
}
