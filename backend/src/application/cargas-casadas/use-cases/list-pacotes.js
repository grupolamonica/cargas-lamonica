import { withPgClient } from "../../../infrastructure/pg/postgres.js";

/**
 * Lista pacotes com paginacao + agregacao de cargas + cliente.nome.
 *
 * Estrategia anti-N+1: 3 queries totais, independente do tamanho do resultset
 *  1) COUNT(*) (paginacao total)
 *  2) SELECT pacotes LIMIT/OFFSET
 *  3) SELECT cargas JOIN clientes WHERE viagem_id IN (...pacote_ids)
 *
 * In-memory join evita correlated subquery (limitacao do pg-mem em testes) +
 * mantem-se eficiente em postgres real (uma scan parametrizada por ANY/IN com indice
 * idx_cargas_viagem_id).
 */
export async function listPacotes({ status, limit, offset, correlationId }) {
  return withPgClient(async (client) => {
    const params = [];
    let whereClause = "";

    if (status) {
      params.push(status);
      whereClause = `WHERE status = $${params.length}`;
    }

    const countSql = `SELECT COUNT(*)::int AS total FROM public.cargas_casadas ${whereClause}`;
    const { rows: countRows } = await client.query(countSql, params);
    const total = countRows[0]?.total ?? 0;

    params.push(limit);
    params.push(offset);
    const limitParam = `$${params.length - 1}`;
    const offsetParam = `$${params.length}`;

    const pacotesSql = `
      SELECT id, status, valor_total, version, published_at,
             reserved_driver_id, reserved_claim_id, booked_driver_id,
             created_by, created_at, updated_at
        FROM public.cargas_casadas
        ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
    const { rows: pacotes } = await client.query(pacotesSql, params);

    const pacoteIds = pacotes.map((p) => p.id);
    let cargasByPacote = new Map();

    if (pacoteIds.length > 0) {
      // Placeholder dinamico $1,$2,... funciona em pg real e em pg-mem
      // (que tem suporte limitado a ANY($1::uuid[]) em alguns cenarios).
      const placeholders = pacoteIds.map((_, i) => `$${i + 1}`).join(", ");
      const cargasSql = `
        SELECT c.id,
               c.viagem_id,
               c.ordem_viagem,
               c.status,
               c.origem,
               c.destino,
               c.valor,
               c.bonus,
               c.data,
               c.horario,
               c.perfil,
               c.cliente_id,
               cl.nome AS cliente_nome
          FROM public.cargas c
          LEFT JOIN public.clientes cl ON cl.id = c.cliente_id
         WHERE c.viagem_id IN (${placeholders})
         ORDER BY c.ordem_viagem ASC NULLS LAST, c.id ASC
      `;
      const { rows: cargas } = await client.query(cargasSql, pacoteIds);
      cargasByPacote = cargas.reduce((acc, c) => {
        if (!acc.has(c.viagem_id)) acc.set(c.viagem_id, []);
        acc.get(c.viagem_id).push({
          id: c.id,
          ordem_viagem: c.ordem_viagem,
          status: c.status,
          origem: c.origem,
          destino: c.destino,
          valor: c.valor !== null ? Number(c.valor) : null,
          bonus: c.bonus !== null ? Number(c.bonus) : null,
          data: c.data,
          horario: c.horario,
          perfil: c.perfil,
          cliente_id: c.cliente_id,
          cliente_nome: c.cliente_nome,
        });
        return acc;
      }, new Map());
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        items: pacotes.map((row) => ({
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
          cargas: cargasByPacote.get(row.id) ?? [],
        })),
        pagination: { total, limit, offset },
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
