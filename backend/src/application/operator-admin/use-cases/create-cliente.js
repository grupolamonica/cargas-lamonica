import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { isMissingClienteLogoColumnError } from "./_shared.js";

// NOTA: as colunas legadas `rastreamento`/`antt` (texto "Obrigatorio"/null) foram
// removidas do INSERT. Elas eram write-only — nada no backend as LÊ (a leitura usa
// exige_rastreamento/exige_antt). Escrevê-las quebrava o cadastro em bancos que não
// as têm (drift entre ambientes). Onde ainda existem, ficam com o default/null (sem
// impacto, pois ninguém as consome).
export async function createOperatorCliente({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const values = [
      payload.nome, payload.descricao, payload.logo_url, payload.logo_url_card, payload.logo_url_proximas,
      JSON.stringify(payload.custom_reputacoes ?? []), JSON.stringify(payload.custom_exigencias ?? []),
      payload.forma_pagamento, payload.prazo_pagamento, payload.exige_rastreamento, payload.exige_antt,
      payload.exige_seguro, payload.exige_carga_monitorada, payload.reputacao_pagamento_rapido,
      payload.reputacao_bom_pagador, payload.reputacao_liberacao_rapida,
      payload.reputacao_carga_organizada, payload.reputacao_boa_comunicacao,
      payload.observacoes,
    ];
    const warnings = [];

    try {
      await client.query(
        `
          INSERT INTO public.clientes (
            nome, descricao, logo_url, logo_url_card, logo_url_proximas,
            custom_reputacoes, custom_exigencias,
            forma_pagamento, prazo_pagamento,
            exige_rastreamento, exige_antt, exige_seguro, exige_carga_monitorada,
            reputacao_pagamento_rapido, reputacao_bom_pagador, reputacao_liberacao_rapida,
            reputacao_carga_organizada, reputacao_boa_comunicacao, observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        `,
        values,
      );
    } catch (error) {
      if (!isMissingClienteLogoColumnError(error)) throw error;
      // Fallback: colunas logo_url/logo_url_card/logo_url_proximas (e custom_*) ainda
      // não presentes no schema — insere sem elas.
      await client.query(
        `
          INSERT INTO public.clientes (
            nome, descricao, forma_pagamento, prazo_pagamento,
            exige_rastreamento, exige_antt, exige_seguro, exige_carga_monitorada,
            reputacao_pagamento_rapido, reputacao_bom_pagador, reputacao_liberacao_rapida,
            reputacao_carga_organizada, reputacao_boa_comunicacao, observacoes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `,
        [values[0], values[1], values[7], values[8], values[9], values[10], values[11], values[12],
         values[13], values[14], values[15], values[16], values[17], values[18]],
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
