import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

// Lista todas as rotas atreladas a um cliente, com tarifas por veículo e
// métricas (km/duração). Usa a view v_clientes_com_rotas (criada na migration
// 20260508000001) para evitar 3 joins manuais; agrupa em memória por rota_id.
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
         vcr.rota_id        AS rota_id,
         vcr.origem         AS origem,
         vcr.destino        AS destino,
         vcr.distancia_km   AS distancia_km,
         vcr.tipo_veiculo   AS tipo_veiculo,
         vcr.valor_frete    AS valor_frete,
         vcr.bonus          AS bonus,
         vcr.bonus_exigencias AS bonus_exigencias
       FROM public.v_clientes_com_rotas vcr
       WHERE vcr.cliente_id = $1
       ORDER BY vcr.origem, vcr.destino, vcr.tipo_veiculo NULLS LAST`,
      [clienteId],
    );

    // Agrupa por rota_id; cada rota carrega array de tarifas (uma por tipo_veiculo)
    const byRota = new Map();
    for (const row of rows) {
      const key = row.rota_id;
      if (!byRota.has(key)) {
        byRota.set(key, {
          rota_id: row.rota_id,
          origem: row.origem,
          destino: row.destino,
          distancia_km: row.distancia_km,
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
