import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { isMissingClienteLogoColumnError } from "./_shared.js";

export async function updateOperatorCliente({ clienteId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM public.clientes WHERE id = $1 FOR UPDATE`,
      [clienteId],
    );

    if (!rows[0]) {
      throw new NotFoundError("Embarcador nao encontrado.");
    }

    const values = [
      clienteId, payload.nome, payload.descricao, payload.logo_url, payload.forma_pagamento,
      payload.prazo_pagamento, payload.exige_rastreamento, payload.exige_antt,
      payload.exige_seguro, payload.exige_carga_monitorada, payload.reputacao_pagamento_rapido,
      payload.reputacao_bom_pagador, payload.reputacao_liberacao_rapida,
      payload.reputacao_carga_organizada, payload.reputacao_boa_comunicacao,
      payload.exige_rastreamento ? "Obrigatorio" : null,
      payload.exige_antt ? "Obrigatorio" : null,
      payload.observacoes,
    ];
    const warnings = [];

    try {
      await client.query(
        `
          UPDATE public.clientes
          SET
            nome = $2, descricao = $3, logo_url = $4, forma_pagamento = $5,
            prazo_pagamento = $6, exige_rastreamento = $7, exige_antt = $8,
            exige_seguro = $9, exige_carga_monitorada = $10,
            reputacao_pagamento_rapido = $11, reputacao_bom_pagador = $12,
            reputacao_liberacao_rapida = $13, reputacao_carga_organizada = $14,
            reputacao_boa_comunicacao = $15, rastreamento = $16, antt = $17, observacoes = $18
          WHERE id = $1
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) throw error;
      await client.query(
        `
          UPDATE public.clientes
          SET
            nome = $2, descricao = $3, forma_pagamento = $4, prazo_pagamento = $5,
            exige_rastreamento = $6, exige_antt = $7, exige_seguro = $8,
            exige_carga_monitorada = $9, reputacao_pagamento_rapido = $10,
            reputacao_bom_pagador = $11, reputacao_liberacao_rapida = $12,
            reputacao_carga_organizada = $13, reputacao_boa_comunicacao = $14,
            rastreamento = $15, antt = $16, observacoes = $17
          WHERE id = $1
        `,
        values.filter((_, index) => index !== 3),
      );
      warnings.push("Client logo column is not available in the current database schema.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      resourceId: clienteId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { nome: payload.nome, hasLogoUrl: Boolean(payload.logo_url) },
    });

    return {
      statusCode: 200,
      payload: { ok: true, warnings, meta: { correlationId } },
    };
  });
}
