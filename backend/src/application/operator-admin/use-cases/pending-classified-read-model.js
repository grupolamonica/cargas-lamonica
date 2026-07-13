import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";
import { getCadastroProblemas } from "./pending-registration-problemas.js";

// Lista de pendentes CLASSIFICADA em dois baldes (aba "Dados incompletos" + a
// própria "Pendentes de revisão"):
//   - bucket "incompletos": cadastros com problema (dado faltando / não conforme),
//     cada item traz `problemas[]` com o motivo.
//   - bucket "revisao": cadastros sem problema (prontos pra revisar).
//
// A classificação é 100% em JS (getCadastroProblemas) — sem SQL novo, fonte única,
// consistente entre os dois baldes e testável. Como é derivado do JSONB, nenhuma
// linha do banco muda de status (reversível). Busca/ordenação/paginação também em
// JS sobre o conjunto de pendentes (limitado — telas de operador, baixo volume).

const MAX_PENDING_SCAN = 2000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const SORT_ACCESSORS = {
  nome: (r) => (r.nome_motorista || "").toLowerCase(),
  placa: (r) => (r.placa_cavalo || "").toLowerCase(),
  enviado: (r) => (r.created_at ? new Date(r.created_at).getTime() : 0),
  status: (r) => (r.status || "").toLowerCase(),
};

function matchesSearch(row, term, digits) {
  if (!term) return true;
  const t = term.toLowerCase();
  const nome = (row.nome_motorista || "").toLowerCase();
  const placa = (row.placa_cavalo || "").toLowerCase();
  const idc = (row.id_cadastro || "").toLowerCase();
  if (nome.includes(t) || placa.includes(t) || idc.includes(t)) return true;
  if (digits && (row.cpf_motorista || "").includes(digits)) return true;
  const carretas = Array.isArray(row.dados?.carretas) ? row.dados.carretas : [];
  return carretas.some((c) => String(c?.placa || "").toLowerCase().includes(t));
}

/**
 * @param {object} opts
 * @param {"incompletos"|"revisao"} opts.bucket
 * @param {string} [opts.search]
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @param {string} [opts.sort]  'nome'|'placa'|'enviado'|'status' (default 'enviado')
 * @param {string} [opts.dir]   'asc'|'desc' (default 'desc')
 * @param {string} [opts.correlationId]
 */
export async function fetchPendingClassified({ bucket, search, page, pageSize, sort, dir, correlationId }) {
  const wantIncompletos = bucket === "incompletos";
  const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
  const safePageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize || DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );
  const term = typeof search === "string" && search.trim() ? search.trim() : null;
  const digits = term ? term.replace(/\D/g, "") : "";
  const searchDigits = digits.length >= 3 ? digits : "";
  const sortKey = Object.hasOwn(SORT_ACCESSORS, sort) ? sort : "enviado";
  const asc = String(dir || "").toLowerCase() === "asc";

  return withPgClient(async (client) => {
    // Só cadastros pendentes de revisão participam da classificação.
    const { rows } = await client.query(
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
      WHERE status = 'pendente'
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [MAX_PENDING_SCAN],
    );

    // Classifica + separa nos dois baldes (aplicando a busca livre em JS).
    let countRevisao = 0;
    let countIncompletos = 0;
    const selected = [];
    for (const row of rows) {
      if (!matchesSearch(row, term, searchDigits)) continue;
      const problemas = getCadastroProblemas(row.dados);
      const isIncompleto = problemas.length > 0;
      if (isIncompleto) countIncompletos += 1;
      else countRevisao += 1;
      if (isIncompleto === wantIncompletos) {
        selected.push({ row, problemas });
      }
    }

    // Ordena o balde selecionado (JS) e pagina.
    const accessor = SORT_ACCESSORS[sortKey];
    selected.sort((a, b) => {
      const av = accessor(a.row);
      const bv = accessor(b.row);
      if (av < bv) return asc ? -1 : 1;
      if (av > bv) return asc ? 1 : -1;
      // Tiebreaker estável: created_at desc, id desc.
      const at = a.row.created_at ? new Date(a.row.created_at).getTime() : 0;
      const bt = b.row.created_at ? new Date(b.row.created_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return String(b.row.id).localeCompare(String(a.row.id));
    });

    const totalCount = wantIncompletos ? countIncompletos : countRevisao;
    const offset = (safePage - 1) * safePageSize;
    const pageRows = selected.slice(offset, offset + safePageSize);

    const items = pageRows.map(({ row, problemas }) => ({
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
      ...(wantIncompletos ? { problemas, n_problemas: problemas.length } : {}),
    }));

    return {
      statusCode: 200,
      payload: {
        items,
        meta: buildPaginationMeta(safePage, safePageSize, totalCount, MAX_PAGE_SIZE, correlationId),
        counts: { revisao: countRevisao, incompletos: countIncompletos, total: countRevisao + countIncompletos },
        truncated: rows.length >= MAX_PENDING_SCAN,
      },
    };
  });
}
