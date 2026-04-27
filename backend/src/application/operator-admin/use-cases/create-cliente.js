import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { isMissingClienteLogoColumnError } from "./_shared.js";

export async function createOperatorCliente({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const values = [
      payload.nome, payload.descricao, payload.logo_url, payload.forma_pagamento,
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
          INSERT INTO public.clientes (
            nome, descricao, logo_url, forma_pagamento, prazo_pagamento,
            exige_rastreamento, exige_antt, exige_seguro, exige_carga_monitorada,
            reputacao_pagamento_rapido, reputacao_bom_pagador, reputacao_liberacao_rapida,
            reputacao_carga_organizada, reputacao_boa_comunicacao, rastreamento, antt, observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) throw error;
      await client.query(
        `
          INSERT INTO public.clientes (
            nome, descricao, forma_pagamento, prazo_pagamento,
            exige_rastreamento, exige_antt, exige_seguro, exige_carga_monitorada,
            reputacao_pagamento_rapido, reputacao_bom_pagador, reputacao_liberacao_rapida,
            reputacao_carga_organizada, reputacao_boa_comunicacao, rastreamento, antt, observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `,
        values.filter((_, index) => index !== 2),
      );
      warnings.push("Client logo column is not available in the current database schema.");
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cliente.created",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cliente",
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { nome: payload.nome, hasLogoUrl: Boolean(payload.logo_url) },
    });

    return {
      statusCode: 201,
      payload: { ok: true, warnings, meta: { correlationId } },
    };
  });
}
