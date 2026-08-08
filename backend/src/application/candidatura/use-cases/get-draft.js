import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { hashDraftToken } from "../../../domain/candidatura/draft-token.js";

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
 * Iter #7: quando `cargaId` e fornecido, busca o draft daquela carga especifica
 * (suporta multi-draft simultaneo). Sem cargaId mantem comportamento legacy
 * (draft mais recente — chamadas antigas do frontend que ainda nao passam carga).
 *
 * - Se nao existe row OU updated_at < now() - 72h → 204 (sem payload).
 * - Caso contrario → 200 com { draft: { id, cargaId, dados, updatedAt }, expiresAt }.
 *
 * Importante: TTL e SLIDING (B-03) — qualquer save subsequente reseta a janela
 * porque o trigger BEFORE UPDATE move updated_at = now() (plan 01).
 *
 * @param {Object} args
 * @param {string} args.driverUserId UUID do motorista autenticado.
 * @param {string} [args.cargaId] Quando presente, escopa o draft a esta carga (iter #7).
 * @param {string} [args.correlationId]
 * @returns {Promise<{ statusCode: number, payload?: object }>}
 */
export async function getCandidaturaDraft({ driverUserId, cargaId, correlationId }) {
  return withPgClient(async (client) => {
    // Iter #7: prefere o draft especifico da cargaId; fallback ao mais recente
    // (e ao legacy com carga_id IS NULL) quando cargaId nao foi fornecido.
    const scopedByCarga = cargaId ? true : false;
    const result = scopedByCarga
      ? await client.query(
          `
            SELECT id, carga_id, dados, updated_at
            FROM public.pending_driver_registrations
            WHERE driver_user_id = $1
              AND status = 'draft'
              AND versao_cadastro = 'v2'
              AND updated_at > now() - interval '72 hours'
              AND (carga_id = $2 OR carga_id IS NULL)
            ORDER BY (carga_id = $2) DESC, updated_at DESC
            LIMIT 1
          `,
          [driverUserId, cargaId],
        )
      : await client.query(
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
/**
 * Le o rascunho anonimo pelo TOKEN DE POSSE (DC-283 / CRIT-3).
 *
 * Substitui a leitura por CPF, que era o BOLA: `?cpf=` devolvia a ficha inteira
 * (CNH, RG, endereco, credencial de rastreador) pra qualquer CPF informado, e
 * CPF nao e segredo no Brasil.
 *
 * A busca e pelo HASH do token, entao nem o CPF entra na consulta — o que
 * tambem tira o CPF da query string do GET (achado ALTO-17).
 *
 * Token invalido, ausente ou expirado devolve 204, igual a "nao existe
 * rascunho": nao ha como distinguir os casos de fora, entao nao ha oraculo.
 */
export async function getCandidaturaDraftByToken({ draftToken, correlationId }) {
  const tokenHash = hashDraftToken(draftToken);

  if (!tokenHash) {
    return { statusCode: 204 };
  }

  return withPgClient(async (client) => {
    const result = await client.query(
      `
        SELECT id, carga_id, dados, updated_at
        FROM public.pending_driver_registrations
        WHERE status = 'draft'
          AND versao_cadastro = 'v2'
          AND driver_user_id IS NULL
          AND draft_token_hash = $1
          AND updated_at > now() - interval '72 hours'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [tokenHash],
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
