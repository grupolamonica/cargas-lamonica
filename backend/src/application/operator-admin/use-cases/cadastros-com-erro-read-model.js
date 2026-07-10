import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const ORIGENS = new Set(["angellira", "spx"]);

/**
 * Lista de cadastros cujo cadastro EXTERNO (Angellira/SPX) falhou — a sub-aba
 * "Com erro" (DC-196). Auto-derivado de `external_registration_jobs`: considera
 * só a ÚLTIMA tentativa por (cadastro, target, step); se a última terminou em
 * ERROR, o cadastro entra na lista com a causa (`message`) e a ação sugerida
 * (`acao`). Quem deu retry-OK depois some da lista.
 *
 * @param {object} opts
 * @param {string|null} [opts.origem] - Filtro por origem: 'angellira' | 'spx' | null (todas)
 * @param {number} opts.page
 * @param {number} opts.pageSize
 * @param {string} [opts.correlationId]
 */
export async function fetchCadastrosComErro({ origem, page, pageSize, correlationId }) {
  const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
  const safePageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize || DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );
  const offset = (safePage - 1) * safePageSize;
  const origemFilter =
    typeof origem === "string" && ORIGENS.has(origem.trim().toLowerCase()) ? origem.trim().toLowerCase() : null;

  // CTE compartilhada entre itens e contagem. $1 = origem (nullable).
  // DISTINCT ON pega a última tentativa por (cadastro, target, step); depois
  // filtra só as que terminaram em ERROR e agrega as causas por cadastro.
  const baseCte = `
      WITH latest AS (
        SELECT DISTINCT ON (cadastro_id, target, step)
               cadastro_id, target, step, status, error, created_at
        FROM public.external_registration_jobs
        WHERE cadastro_id IS NOT NULL
          AND ($1::text IS NULL OR target = $1)
        ORDER BY cadastro_id, target, step, created_at DESC
      ),
      erros AS (
        SELECT * FROM latest WHERE status = 'ERROR'
      ),
      cadastros AS (
        SELECT cadastro_id,
               count(*)::int AS n_erros,
               max(created_at) AS ultimo_erro_at,
               jsonb_agg(jsonb_build_object(
                 'target',  target,
                 'step',    step,
                 'code',    error->>'code',
                 'message', error->>'message',
                 'acao',    error->>'acao'
               ) ORDER BY target, step) AS falhas
        FROM erros
        GROUP BY cadastro_id
      )`;

  return withPgClient(async (client) => {
    const [itemsResult, countResult] = await Promise.all([
      client.query(
        `${baseCte}
         SELECT c.cadastro_id                      AS id,
                p.status,
                p.dados->'motorista'->>'nome'       AS nome_motorista,
                p.dados->'motorista'->>'cpf'        AS cpf_motorista,
                p.dados->'cavalo'->>'placa'         AS placa_cavalo,
                c.n_erros,
                c.ultimo_erro_at,
                c.falhas
         FROM cadastros c
         LEFT JOIN public.pending_driver_registrations p ON p.id = c.cadastro_id
         ORDER BY c.ultimo_erro_at DESC
         LIMIT $2 OFFSET $3`,
        [origemFilter, safePageSize, offset],
      ),
      client.query(`${baseCte} SELECT count(*)::int AS total FROM cadastros`, [origemFilter]),
    ]);

    const totalCount = countResult.rows[0]?.total ?? 0;

    return {
      statusCode: 200,
      payload: {
        items: itemsResult.rows.map((row) => ({
          id: row.id,
          status: row.status || null,
          nome_motorista: row.nome_motorista || null,
          cpf_motorista: row.cpf_motorista || null,
          placa_cavalo: row.placa_cavalo || null,
          n_erros: row.n_erros,
          ultimo_erro_at: row.ultimo_erro_at || null,
          falhas: Array.isArray(row.falhas) ? row.falhas : [],
        })),
        meta: buildPaginationMeta(safePage, safePageSize, totalCount, MAX_PAGE_SIZE, correlationId),
      },
    };
  });
}
