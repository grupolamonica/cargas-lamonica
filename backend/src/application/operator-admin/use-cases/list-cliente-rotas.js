import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

// Lista todas as rotas atreladas a um cliente, com tarifas por veículo
// e métricas (km/duração). Modelo 1:N: SELECT direto em rotas WHERE
// cliente_id = $1, juntando tarifas. Agrupa em memória por rota_id.
export async function listClienteRotas({ clienteId, correlationId }) {
  return withPgClient(async (client) => {
    const exists = await client.query(
      `SELECT id, nome FROM public.clientes WHERE id = $1 LIMIT 1`,
      [clienteId],
    );
    if (exists.rowCount === 0) {
      throw new NotFoundError(`Cliente ${clienteId} nao encontrado.`, "CLIENTE_NOT_FOUND");
    }

    const { rows } = await client.query(
      `SELECT
         r.id            AS rota_id,
         r.origem,
         r.destino,
         r.distancia_km,
         r.duracao_horas,
         r.ativa,
         rt.tipo_veiculo,
         rt.valor_frete,
         rt.bonus,
         rt.bonus_exigencias
       FROM public.rotas r
       LEFT JOIN public.rota_tarifas rt
              ON rt.rota_id = r.id AND rt.ativa = true
       WHERE r.cliente_id = $1
       ORDER BY r.origem, r.destino, rt.tipo_veiculo NULLS LAST`,
      [clienteId],
    );

    const byRota = new Map();
    for (const row of rows) {
      const key = row.rota_id;
      if (!byRota.has(key)) {
        byRota.set(key, {
          rota_id: row.rota_id,
          origem: row.origem,
          destino: row.destino,
          distancia_km: row.distancia_km,
          duracao_horas: row.duracao_horas,
          ativa: row.ativa,
          tarifas: [],
        });
      }
      if (row.tipo_veiculo) {
        byRota.get(key).tarifas.push({
          tipo_veiculo: row.tipo_veiculo,
          valor_frete: row.valor_frete,
          bonus: row.bonus,
          bonus_exigencias: row.bonus_exigencias,
        });
      }
    }

    return {
      statusCode: 200,
      payload: {
        cliente_id: clienteId,
        cliente_nome: exists.rows[0].nome,
        rotas: Array.from(byRota.values()),
        meta: { correlationId },
      },
    };
  });
}
