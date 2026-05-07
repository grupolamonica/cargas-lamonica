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
      clienteId, payload.nome, payload.descricao,
      payload.logo_url, payload.logo_url_card, payload.logo_url_proximas,
      JSON.stringify(payload.custom_reputacoes ?? []), JSON.stringify(payload.custom_exigencias ?? []),
      payload.forma_pagamento, payload.prazo_pagamento, payload.exige_rastreamento, payload.exige_antt,
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
            nome = $2, descricao = $3,
            logo_url = $4, logo_url_card = $5, logo_url_proximas = $6,
            custom_reputacoes = $7, custom_exigencias = $8,
            forma_pagamento = $9, prazo_pagamento = $10,
            exige_rastreamento = $11, exige_antt = $12,
            exige_seguro = $13, exige_carga_monitorada = $14,
            reputacao_pagamento_rapido = $15, reputacao_bom_pagador = $16,
            reputacao_liberacao_rapida = $17, reputacao_carga_organizada = $18,
            reputacao_boa_comunicacao = $19, rastreamento = $20, antt = $21, observacoes = $22
          WHERE id = $1
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) throw error;
      // Fallback: columns logo_url/logo_url_card/logo_url_proximas not yet in DB
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
        [values[0], values[1], values[2], values[8], values[9], values[10], values[11], values[12],
         values[13], values[14], values[15], values[16], values[17], values[18], values[19], values[20], values[21]],
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
