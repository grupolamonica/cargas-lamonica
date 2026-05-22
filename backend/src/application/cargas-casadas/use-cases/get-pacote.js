import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/**
 * Detalhes de um pacote com cargas ordenadas por ordem_viagem + cliente.nome.
 * 2 queries (pacote + cargas) — sem N+1.
 */
export async function getPacote({ pacoteId, correlationId }) {
  return withPgClient(async (client) => {
    const { rows: pacoteRows } = await client.query(
      `SELECT id, status, valor_total, version, published_at,
              reserved_driver_id, reserved_claim_id, booked_driver_id,
              created_by, created_at, updated_at
         FROM public.cargas_casadas
        WHERE id = $1`,
      [pacoteId],
    );

    if (pacoteRows.length === 0) {
      throw new NotFoundError("Pacote nao encontrado.");
    }
    const pacote = pacoteRows[0];

    const { rows: cargas } = await client.query(
      `SELECT c.id,
              c.ordem_viagem,
              c.status,
              c.driver_visibility,
              c.origem,
              c.destino,
              c.valor,
              c.bonus,
              c.bonus_exigencias,
              c.data,
              c.horario,
              c.perfil,
              c.distancia_km,
              c.duracao_horas,
              c.cliente_id,
              cl.nome AS cliente_nome,
              cl.logo_url AS cliente_logo_url
         FROM public.cargas c
         LEFT JOIN public.clientes cl ON cl.id = c.cliente_id
        WHERE c.viagem_id = $1
        ORDER BY c.ordem_viagem ASC NULLS LAST, c.id ASC`,
      [pacoteId],
    );

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacote: {
          id: pacote.id,
          status: pacote.status,
          valor_total: pacote.valor_total !== null ? Number(pacote.valor_total) : null,
          version: pacote.version,
          published_at: pacote.published_at,
          reserved_driver_id: pacote.reserved_driver_id,
          reserved_claim_id: pacote.reserved_claim_id,
          booked_driver_id: pacote.booked_driver_id,
          created_by: pacote.created_by,
          created_at: pacote.created_at,
          updated_at: pacote.updated_at,
        },
        cargas: cargas.map((c) => ({
          id: c.id,
          ordem_viagem: c.ordem_viagem,
          status: c.status,
          driver_visibility: c.driver_visibility,
          origem: c.origem,
          destino: c.destino,
          valor: c.valor !== null ? Number(c.valor) : null,
          bonus: c.bonus !== null ? Number(c.bonus) : null,
          bonus_exigencias: c.bonus_exigencias,
          data: c.data,
          horario: c.horario,
          perfil: c.perfil,
          distancia_km: c.distancia_km !== null ? Number(c.distancia_km) : null,
          duracao_horas: c.duracao_horas !== null ? Number(c.duracao_horas) : null,
          cliente_id: c.cliente_id,
          cliente_nome: c.cliente_nome,
          cliente_logo_url: c.cliente_logo_url,
        })),
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
