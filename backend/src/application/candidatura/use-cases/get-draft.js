import { withPgClient } from "../../../infrastructure/pg/postgres.js";

// TTL SLIDING: 72h desde o ultimo updated_at (D-05 + B-03).
const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

function computeExpiresAtIso(updatedAt) {
  if (updatedAt instanceof Date) {
    return new Date(updatedAt.getTime() + DRAFT_TTL_MS).toISOString();
  }
  return new Date(new Date(updatedAt).getTime() + DRAFT_TTL_MS).toISOString();
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/**
 * Le o draft do motorista autenticado, aplicando TTL SLIDING via updated_at.
 *
 * - Se nao existe row OU updated_at < now() - 72h → 204 (sem payload).
 * - Caso contrario → 200 com { draft: { id, cargaId, dados, updatedAt }, expiresAt }.
 *
 * Importante: TTL e SLIDING (B-03) — qualquer save subsequente reseta a janela
 * porque o trigger BEFORE UPDATE move updated_at = now() (plan 01).
 *
 * @param {Object} args
 * @param {string} args.driverUserId UUID do motorista autenticado.
 * @param {string} [args.correlationId]
 * @returns {Promise<{ statusCode: number, payload?: object }>}
 */
export async function getCandidaturaDraft({ driverUserId, correlationId }) {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        SELECT id, carga_id, dados, updated_at
        FROM public.pending_driver_registrations
        WHERE driver_user_id = $1
          AND status = 'draft'
          AND versao_cadastro = 'v2'
          AND updated_at > now() - interval '72 hours'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [driverUserId],
    );

    if (result.rows.length === 0) {
      return { statusCode: 204 };
    }

    const row = result.rows[0];
    const updatedAtIso = toIsoString(row.updated_at);
    const expiresAt = computeExpiresAtIso(row.updated_at);

    return {
      statusCode: 200,
      payload: {
        draft: {
          id: row.id,
          cargaId: row.carga_id,
          dados: row.dados,
          updatedAt: updatedAtIso,
        },
        expiresAt,
        meta: { correlationId },
      },
    };
  });
}

/**
 * Le o draft PUBLICO (driver_user_id IS NULL) identificado por CPF.
 *
 * Espelha a regra de unicidade de `saveCandidaturaDraftByCpf` — 1 draft ativo
 * por CPF entre os anonimos. Mesma janela TTL de 72h (sliding via updated_at).
 *
 * @param {Object} args
 * @param {string} args.cpf CPF normalizado (11 digitos).
 * @param {string} [args.correlationId]
 */
export async function getCandidaturaDraftByCpf({ cpf, correlationId }) {
  return withPgClient(async (client) => {
    const result = await client.query(
      `
        SELECT id, carga_id, dados, updated_at
        FROM public.pending_driver_registrations
        WHERE status = 'draft'
          AND versao_cadastro = 'v2'
          AND driver_user_id IS NULL
          AND dados->'motorista'->>'cpf' = $1
          AND updated_at > now() - interval '72 hours'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [cpf],
    );

    if (result.rows.length === 0) {
      return { statusCode: 204 };
    }

    const row = result.rows[0];
    const updatedAtIso = toIsoString(row.updated_at);
    const expiresAt = computeExpiresAtIso(row.updated_at);

    return {
      statusCode: 200,
      payload: {
        draft: {
          id: row.id,
          cargaId: row.carga_id,
          dados: row.dados,
          updatedAt: updatedAtIso,
        },
        expiresAt,
        meta: { correlationId },
      },
    };
  });
}
