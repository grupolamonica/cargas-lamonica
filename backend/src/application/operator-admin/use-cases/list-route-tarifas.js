import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/**
 * Lista tarifas ativas ou inativas de uma rota (`rota_tarifas`).
 * Retorna `[]` quando a rota existe mas nao tem tarifa cadastrada.
 * Lanca NotFoundError se a rota nao existir.
 */
export async function listRouteTarifas({ routeId, correlationId }) {
  return withPgClient(async (client) => {
    const { rows: rotaRows } = await client.query(
      `SELECT id FROM public.rotas WHERE id = $1`,
      [routeId],
    );

    if (!rotaRows[0]) throw new NotFoundError("Rota nao encontrada.");

    const { rows } = await client.query(
      `
        SELECT
          id, rota_id, tipo_veiculo, eixos, valor_frete, bonus,
          bonus_exigencias, ativa, observacoes, created_at, updated_at
        FROM public.rota_tarifas
        WHERE rota_id = $1
        ORDER BY tipo_veiculo ASC, eixos ASC
      `,
      [routeId],
    );

    return {
      statusCode: 200,
      payload: {
        items: rows,
        meta: { correlationId },
      },
    };
  });
}
