import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";
import { fetchPendingClassified } from "./pending-classified-read-model.js";

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
 * @param {string} [opts.sort]   - Ordenação (DC-197): 'nome' | 'placa' | 'enviado' | 'status' (default 'enviado')
 * @param {string} [opts.dir]    - Direção: 'asc' | 'desc' (default 'desc')
 * @param {string} [opts.correlationId]
 */
export async function fetchPendingDriverRegistrations({ status, search, page, pageSize, sort, dir, excluirIncompletos, correlationId }) {
  // Aba "Dados incompletos": quando a revisão pede pra esconder os cadastros com
  // problema, delega ao read-model classificado (mesma classificação JS, fonte
  // única, derivado — sem mutação). Só pendentes participam da classificação.
  if (excluirIncompletos) {
    return fetchPendingClassified({ bucket: "revisao", search, page, pageSize, sort, dir, correlationId });
  }
  const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
  const safePageSize = Math.min(
    PENDING_DRIVER_MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize || PENDING_DRIVER_DEFAULT_PAGE_SIZE), 10) || PENDING_DRIVER_DEFAULT_PAGE_SIZE),
  );
  const offset = (safePage - 1) * safePageSize;
  const statusFilter = typeof status === "string" && status.trim() ? status.trim() : null;
  // Busca livre: nome do motorista, placa do cavalo/carretas, id_cadastro (ILIKE),
  // e CPF por dígitos (o CPF é armazenado só com dígitos no `dados`).
  const searchTerm = typeof search === "string" && search.trim() ? search.trim() : null;
  const searchDigits = searchTerm ? searchTerm.replace(/\D/g, "") : "";
  const searchDigitsFilter = searchDigits.length >= 3 ? searchDigits : null;

  // Ordenação (DC-197): colunas permitidas mapeadas para expressões SEGURAS.
  // Nunca interpola entrada crua — a chave é validada contra este whitelist.
  const SORT_EXPR = {
    nome: "dados->'motorista'->>'nome'",
    placa: "dados->'cavalo'->>'placa'",
    enviado: "created_at",
    status: "status",
  };
  const sortKey = typeof sort === "string" && Object.hasOwn(SORT_EXPR, sort) ? sort : "enviado";
  const sortDir = String(dir || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  // Tiebreaker estável (created_at, id) → paginação determinística.
  const orderByClause = `ORDER BY ${SORT_EXPR[sortKey]} ${sortDir} NULLS LAST, created_at DESC, id DESC`;

  // WHERE compartilhado entre a query de itens e a de contagem ($1=status, $2=termo, $3=dígitos).
  const whereClause = `
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR (
                dados->'motorista'->>'nome' ILIKE '%' || $2 || '%'
             OR dados->'cavalo'->>'placa'   ILIKE '%' || $2 || '%'
             OR id_cadastro                 ILIKE '%' || $2 || '%'
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(dados->'carretas', '[]'::jsonb)) AS carreta
                  WHERE carreta->>'placa' ILIKE '%' || $2 || '%'
                )
             OR ($3::text IS NOT NULL AND dados->'motorista'->>'cpf' LIKE '%' || $3 || '%')
          ))`;

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
        ${whereClause}
        ${orderByClause}
        LIMIT $4 OFFSET $5
        `,
        [statusFilter, searchTerm, searchDigitsFilter, safePageSize, offset],
      ),
      client.query(
        `
        SELECT COUNT(*)::int AS total
        FROM public.pending_driver_registrations
        ${whereClause}
        `,
        [statusFilter, searchTerm, searchDigitsFilter],
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
