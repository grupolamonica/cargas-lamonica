import { withPgClient } from "../../../infrastructure/pg/postgres.js";

/**
 * Lista pacotes com paginacao + agregacao de cargas + cliente.nome.
 * Performance: 2 queries (count + items) — sem N+1 (json_agg in-query).
 *
 * Aceita { status, limit, offset } ja validados pelo zod no handler.
 */
export async function listPacotes({ status, limit, offset, correlationId }) {
  return withPgClient(async (client) => {
    const params = [];
    let whereClause = "";

    if (status) {
      params.push(status);
      whereClause = `WHERE cc.status = $${params.length}`;
    }

    const countSql = `SELECT COUNT(*)::int AS total FROM public.cargas_casadas cc ${whereClause}`;
    const { rows: countRows } = await client.query(countSql, params);
    const total = countRows[0]?.total ?? 0;

    params.push(limit);
    params.push(offset);
    const limitParam = `$${params.length - 1}`;
    const offsetParam = `$${params.length}`;

    const itemsSql = `
      SELECT
        cc.id,
        cc.status,
        cc.valor_total,
        cc.version,
        cc.published_at,
        cc.reserved_driver_id,
        cc.reserved_claim_id,
        cc.booked_driver_id,
        cc.created_by,
        cc.created_at,
        cc.updated_at,
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object(
                       'id', c.id,
                       'ordem_viagem', c.ordem_viagem,
                       'status', c.status,
                       'origem', c.origem,
                       'destino', c.destino,
                       'valor', c.valor,
                       'bonus', c.bonus,
                       'data', c.data,
                       'horario', c.horario,
                       'perfil', c.perfil,
                       'cliente_id', c.cliente_id,
                       'cliente_nome', cl.nome
                     )
                     ORDER BY c.ordem_viagem ASC NULLS LAST, c.id ASC
                   )
            FROM public.cargas c
            LEFT JOIN public.clientes cl ON cl.id = c.cliente_id
            WHERE c.viagem_id = cc.id
          ),
          '[]'::json
        ) AS cargas
      FROM public.cargas_casadas cc
      ${whereClause}
      ORDER BY cc.created_at DESC, cc.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const { rows: items } = await client.query(itemsSql, params);

    return {
      statusCode: 200,
      payload: {
        ok: true,
        items: items.map((row) => ({
          id: row.id,
          status: row.status,
          valor_total: row.valor_total !== null ? Number(row.valor_total) : null,
          version: row.version,
          published_at: row.published_at,
          reserved_driver_id: row.reserved_driver_id,
          reserved_claim_id: row.reserved_claim_id,
          booked_driver_id: row.booked_driver_id,
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          cargas: Array.isArray(row.cargas) ? row.cargas : [],
        })),
        pagination: { total, limit, offset },
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
