import { withPgClient } from "../../../infrastructure/pg/postgres.js";

/**
 * Busca a tarifa ativa que casa com (origem, destino, perfil, eixos).
 * Devolve `{ tarifa: null }` quando nao ha correspondencia — nao lanca 404,
 * porque o cliente (Editar Carga) usa a resposta pra decidir se auto-preenche
 * ou mantem o valor manual.
 */
export async function lookupRouteTarifa({ query, correlationId }) {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT
          rt.id, rt.rota_id, rt.tipo_veiculo, rt.eixos,
          rt.valor_frete, rt.bonus, rt.bonus_exigencias,
          rt.ativa, rt.observacoes
        FROM public.rota_tarifas rt
        JOIN public.rotas r ON r.id = rt.rota_id
        WHERE r.ativa = true
          AND rt.ativa = true
          AND r.origem = $1
          AND r.destino = $2
          AND rt.tipo_veiculo = $3
          AND rt.eixos = $4
        LIMIT 1
      `,
      [query.origem, query.destino, query.perfil, query.eixos ?? 0],
    );

    return {
      statusCode: 200,
      payload: {
        tarifa: rows[0] ?? null,
        meta: { correlationId },
      },
    };
  });
}
