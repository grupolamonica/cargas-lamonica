import { withPgClient } from "../../../infrastructure/pg/postgres.js";

const DRAFT_DEFAULT_PAGE_SIZE = 50;
const DRAFT_MAX_PAGE_SIZE = 200;

const STEP_LABELS = {
  tela0: "Início",
  "step-a": "Etapa A — Motorista",
  "step-b": "Etapa B — Cavalo",
  "step-c": "Etapa C — Proprietário cavalo",
  "step-c-antt": "Etapa C — ANTT cavalo",
  "step-d": "Etapa D — Carretas",
  "step-e": "Etapa E — Proprietário carreta",
  "step-e-antt": "Etapa E — ANTT carreta",
  confirmation: "Confirmação final",
};

const STEP_ORDER = [
  "tela0",
  "step-a",
  "step-b",
  "step-c",
  "step-c-antt",
  "step-d",
  "step-e",
  "step-e-antt",
  "confirmation",
];

function calcProgress(currentStep) {
  const idx = STEP_ORDER.indexOf(currentStep);
  if (idx < 0) return 0;
  return Math.round((idx / (STEP_ORDER.length - 1)) * 100);
}

/**
 * Lista rascunhos de candidaturas (status = 'draft') para o painel do operador.
 * Retorna dados suficientes para identificar o motorista e abrir o wizard de resgate.
 *
 * @param {object} opts
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @param {string} [opts.correlationId]
 */
export async function listDraftRegistrations({ page, pageSize, correlationId } = {}) {
  const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
  const safePageSize = Math.min(
    DRAFT_MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(String(pageSize || DRAFT_DEFAULT_PAGE_SIZE), 10) || DRAFT_DEFAULT_PAGE_SIZE),
  );
  const offset = (safePage - 1) * safePageSize;

  return withPgClient(async (client) => {
    const [itemsResult, countResult] = await Promise.all([
      client.query(
        `
        SELECT
          id,
          carga_id,
          created_at,
          updated_at,
          dados->>'__currentStep'           AS current_step,
          dados->'motorista'->>'cpf'        AS cpf,
          dados->'stepA'->'a1'->>'nome'     AS nome,
          dados->'stepB'->>'placa'          AS placa_cavalo,
          dados->'stepA'->'a1'->>'categoria' AS cnh_categoria,
          (dados ? 'stepA')                 AS has_step_a,
          (dados ? 'stepB')                 AS has_step_b,
          (dados ? 'stepC')                 AS has_step_c,
          (dados ? 'stepD')                 AS has_step_d,
          (dados ? 'stepE')                 AS has_step_e,
          (dados ? '__submitIdempotencyKey') AS has_submit_key
        FROM public.pending_driver_registrations
        WHERE status = 'draft'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [safePageSize, offset],
      ),
      client.query(
        `SELECT COUNT(*)::int AS total FROM public.pending_driver_registrations WHERE status = 'draft'`,
      ),
    ]);

    const totalCount = countResult.rows[0]?.total ?? 0;

    return {
      statusCode: 200,
      payload: {
        items: itemsResult.rows.map((row) => {
          const step = row.current_step || "tela0";
          return {
            id: row.id,
            carga_id: row.carga_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            current_step: step,
            step_label: STEP_LABELS[step] ?? step,
            progress_pct: calcProgress(step),
            at_confirmation: step === "confirmation",
            has_submit_key: Boolean(row.has_submit_key),
            cpf: row.cpf || null,
            nome: row.nome || null,
            placa_cavalo: row.placa_cavalo || null,
            cnh_categoria: row.cnh_categoria || null,
            steps_done: {
              a: Boolean(row.has_step_a),
              b: Boolean(row.has_step_b),
              c: Boolean(row.has_step_c),
              d: Boolean(row.has_step_d),
              e: Boolean(row.has_step_e),
            },
          };
        }),
        meta: {
          page: safePage,
          pageSize: safePageSize,
          total: totalCount,
          correlationId,
        },
      },
    };
  });
}
