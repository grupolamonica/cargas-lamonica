import crypto from "node:crypto";

import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

// TTL SLIDING: 72 horas desde o ultimo updated_at (D-05 + B-03).
const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

function computeExpiresAtIso(updatedAt) {
  if (updatedAt instanceof Date) {
    return new Date(updatedAt.getTime() + DRAFT_TTL_MS).toISOString();
  }
  // Caso o driver retorne ISO string (compatibilidade defensiva).
  return new Date(new Date(updatedAt).getTime() + DRAFT_TTL_MS).toISOString();
}

/**
 * Upsert do draft do candidato (1 ativo por driver_user_id).
 *
 * Estrategia transacional:
 *   1. SELECT ... FOR UPDATE para serializar concorrencia por driver.
 *   2. Se existe → UPDATE dados+carga_id (trigger BEFORE UPDATE seta updated_at).
 *   3. Se nao → INSERT novo (id_cadastro com prefixo CAD-V2- + uuid).
 *
 * IMPORTANTE: NUNCA seta `updated_at` manualmente — o trigger trg_pending_driver_updated_at
 * faz `NEW.updated_at = now()` em qualquer UPDATE (B-03 sliding window).
 *
 * @param {Object} args
 * @param {string} args.driverUserId UUID do motorista autenticado (auth.users.id).
 * @param {string} args.cargaId ID da carga do contexto de candidatura (D-10).
 * @param {Object} args.dados Payload JSONB do wizard.
 * @param {string} [args.requestIp]
 * @param {string} [args.correlationId]
 * @returns {Promise<{ statusCode: number, payload: { id: string, expiresAt: string, meta: { correlationId?: string } } }>}
 */
export async function saveCandidaturaDraft({ driverUserId, cargaId, dados, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    // Lock pessimista por driver para evitar dois INSERTs concorrentes do mesmo motorista.
    const existing = await client.query(
      `
        SELECT id, id_cadastro
        FROM public.pending_driver_registrations
        WHERE driver_user_id = $1
          AND status = 'draft'
          AND versao_cadastro = 'v2'
        FOR UPDATE
      `,
      [driverUserId],
    );

    let row;
    let idCadastro;

    if (existing.rows.length > 0) {
      // UPDATE — trigger BEFORE UPDATE seta updated_at automaticamente (sliding window).
      const draftId = existing.rows[0].id;
      idCadastro = existing.rows[0].id_cadastro;

      const updated = await client.query(
        `
          UPDATE public.pending_driver_registrations
          SET dados = $2::jsonb,
              carga_id = $3
          WHERE id = $1
          RETURNING id, updated_at
        `,
        [draftId, JSON.stringify(dados), cargaId],
      );
      row = updated.rows[0];
    } else {
      // INSERT novo draft.
      idCadastro = `CAD-V2-${crypto.randomUUID()}`;
      const inserted = await client.query(
        `
          INSERT INTO public.pending_driver_registrations (
            id_cadastro,
            status,
            versao_cadastro,
            driver_user_id,
            carga_id,
            dados
          )
          VALUES ($1, 'draft', 'v2', $2, $3, $4::jsonb)
          RETURNING id, updated_at
        `,
        [idCadastro, driverUserId, cargaId, JSON.stringify(dados)],
      );
      row = inserted.rows[0];
    }

    const id = row.id;
    const expiresAt = computeExpiresAtIso(row.updated_at);

    // Audit SEM dados crus (PII).
    await insertSecurityAuditEvent(client, {
      eventType: "driver.candidatura.draft_saved",
      actorUserId: driverUserId,
      actorRole: "driver",
      resourceType: "pending_driver_registration",
      resourceId: id,
      action: existing.rows.length > 0 ? "update" : "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { id_cadastro: idCadastro, carga_id: cargaId },
    });

    return {
      statusCode: 200,
      payload: {
        id,
        expiresAt,
        meta: { correlationId },
      },
    };
  });
}
