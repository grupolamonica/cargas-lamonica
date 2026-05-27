import { withPgClient } from "../../../infrastructure/pg/postgres.js";

// TTL SLIDING: 72h desde o ultimo updated_at (D-05 + B-03).
const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function computeExpiresAtIso(updatedAt) {
  if (!updatedAt) return null;
  const base = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return new Date(base + DRAFT_TTL_MS).toISOString();
}

/**
 * Iter #7 — Lista drafts incompletos (status='draft', versao='v2') do motorista
 * autenticado, com JOIN em public.cargas para devolver origem/destino/horario
 * e renderizar 1 card de notificacao por draft no DriverPortal.
 *
 * Filtros aplicados:
 *   - driver_user_id = $1 (D-01).
 *   - status = 'draft' AND versao_cadastro = 'v2'.
 *   - carga_id IS NOT NULL (drafts legacy sem carga nao geram notificacao,
 *     porque nao temos contexto pra continuar).
 *   - updated_at > now() - 72h (respeita TTL SLIDING).
 *
 * LEFT JOIN com cargas: se a carga foi deletada/cancelada, ainda devolvemos o
 * draft com origem/destino NULL — frontend pode decidir esconder ou exibir
 * fallback.
 *
 * Ordena por updated_at DESC (mais recente primeiro).
 *
 * @param {Object} args
 * @param {string} args.driverUserId
 * @param {string} [args.correlationId]
 * @returns {Promise<{ statusCode: number, payload: { drafts: Array<{ id, cargaId, updatedAt, expiresAt, currentStep, origem, destino, dataColeta, horario }> } }>}
 */
export async function listIncompleteCadastroDrafts({ driverUserId, correlationId }) {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        SELECT
          pdr.id,
          pdr.carga_id,
          pdr.updated_at,
          pdr.dados->>'__currentStep'      AS current_step,
          c.origem                          AS origem,
          c.destino                         AS destino,
          c.data                            AS data_coleta,
          c.horario                         AS horario_coleta
        FROM public.pending_driver_registrations pdr
        LEFT JOIN public.cargas c ON c.id::text = pdr.carga_id
        WHERE pdr.driver_user_id = $1
          AND pdr.status = 'draft'
          AND pdr.versao_cadastro = 'v2'
          AND pdr.carga_id IS NOT NULL
          AND pdr.updated_at > now() - interval '72 hours'
        ORDER BY pdr.updated_at DESC
      `,
      [driverUserId],
    );

    const drafts = result.rows.map((row) => ({
      id: row.id,
      cargaId: row.carga_id,
      currentStep: row.current_step || null,
      updatedAt: toIsoString(row.updated_at),
      expiresAt: computeExpiresAtIso(row.updated_at),
      origem: row.origem ?? null,
      destino: row.destino ?? null,
      dataColeta: toIsoString(row.data_coleta),
      horarioColeta: row.horario_coleta ?? null,
    }));

    return {
      statusCode: 200,
      payload: {
        drafts,
        meta: { correlationId },
      },
    };
  });
}
