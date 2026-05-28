import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";

const PENDING_DRIVER_DEFAULT_PAGE_SIZE = 20;
const PENDING_DRIVER_MAX_PAGE_SIZE = 100;

/**
 * Lista paginada de registros de cadastro pendentes de aprovação.
 * Use-case extraído de read-models.js em AUDIT Wave 4 (split god module).
 *
 * @param {object} opts
 * @param {string|null} opts.status   - Filtro: 'pendente' | 'em_revisao' | 'aprovado' | 'rejeitado' | null (todos)
 * @param {number} opts.page
 * @param {number} opts.pageSize
 * @param {string} [opts.correlationId]
 */
export async function fetchPendingDriverRegistrations({ status, page, pageSize, correlationId }) {
  const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
  const safePageSize = Math.min(
    PENDING_DRIVER_MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize || PENDING_DRIVER_DEFAULT_PAGE_SIZE), 10) || PENDING_DRIVER_DEFAULT_PAGE_SIZE),
  );
  const offset = (safePage - 1) * safePageSize;
  const statusFilter = typeof status === "string" && status.trim() ? status.trim() : null;

  return withPgClient(async (client) => {
    const [itemsResult, countResult] = await Promise.all([
      client.query(
        `
        SELECT
          id,
          id_cadastro,
          created_at,
          status,
          observacoes,
          reviewed_at,
          reviewed_by_id,
          dados->'motorista'->>'nome'  AS nome_motorista,
          dados->'motorista'->>'cpf'   AS cpf_motorista,
          dados->'cavalo'->>'placa'    AS placa_cavalo,
          dados                        AS dados
        FROM public.pending_driver_registrations
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [statusFilter, safePageSize, offset],
      ),
      client.query(
        `
        SELECT COUNT(*)::int AS total
        FROM public.pending_driver_registrations
        WHERE ($1::text IS NULL OR status = $1)
        `,
        [statusFilter],
      ),
    ]);

    const totalCount = countResult.rows[0]?.total ?? 0;

    return {
      statusCode: 200,
      payload: {
        items: itemsResult.rows.map((row) => ({
          id: row.id,
          id_cadastro: row.id_cadastro,
          created_at: row.created_at,
          status: row.status,
          observacoes: row.observacoes || null,
          reviewed_at: row.reviewed_at || null,
          reviewed_by_id: row.reviewed_by_id || null,
          nome_motorista: row.nome_motorista || null,
          cpf_motorista: row.cpf_motorista || null,
          placa_cavalo: row.placa_cavalo || null,
          dados: row.dados || null,
        })),
        meta: buildPaginationMeta(safePage, safePageSize, totalCount, PENDING_DRIVER_MAX_PAGE_SIZE, correlationId),
      },
    };
  });
}
