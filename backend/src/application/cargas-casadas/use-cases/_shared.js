/**
 * Helpers internos para use cases de cargas_casadas.
 * Nao importar de fora deste diretorio.
 */

import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/**
 * SELECT pacote com FOR UPDATE (lock pessimista, atomicidade contra concurrent edits).
 * Lanca NotFoundError quando o pacote nao existe.
 */
export async function selectPacoteForUpdate(client, pacoteId) {
  const { rows } = await client.query(
    `SELECT id, status, valor_total, version, published_at, reserved_driver_id,
            reserved_claim_id, booked_driver_id, created_by, created_at, updated_at
       FROM public.cargas_casadas
      WHERE id = $1
      FOR UPDATE`,
    [pacoteId],
  );

  if (rows.length === 0) {
    throw new NotFoundError("Pacote nao encontrado.");
  }

  return rows[0];
}

/**
 * SELECT carga com FOR UPDATE (idem para evitar TOCTOU em add/publish).
 */
export async function selectCargaForUpdate(client, cargaId) {
  const { rows } = await client.query(
    `SELECT id, status, driver_visibility, viagem_id, ordem_viagem,
            reserved_driver_id, reserved_claim_id, booked_driver_id, cliente_id
       FROM public.cargas
      WHERE id = $1
      FOR UPDATE`,
    [cargaId],
  );

  return rows[0] || null;
}

/**
 * Cargas vinculadas a um pacote, ordenadas por ordem_viagem ASC.
 * forUpdate=true adquire lock em todas as cargas (necessario em publish/cancel).
 */
export async function selectCargasByPacote(client, pacoteId, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? "FOR UPDATE" : "";
  const { rows } = await client.query(
    `SELECT id, status, driver_visibility, viagem_id, ordem_viagem,
            reserved_driver_id, reserved_claim_id, booked_driver_id,
            origem, destino, valor, bonus, cliente_id, data, horario, perfil
       FROM public.cargas
      WHERE viagem_id = $1
      ORDER BY ordem_viagem ASC NULLS LAST, id ASC
      ${lockClause}`,
    [pacoteId],
  );
  return rows;
}

/**
 * Conta cargas vinculadas ao pacote (sem lock).
 */
export async function countCargasByPacote(client, pacoteId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total FROM public.cargas WHERE viagem_id = $1`,
    [pacoteId],
  );
  return rows[0]?.total ?? 0;
}

/**
 * Incrementa version do pacote (D-06: invalida candidaturas pendentes em status='publicado').
 * Retorna a nova version.
 */
export async function bumpPacoteVersion(client, pacoteId) {
  const { rows } = await client.query(
    `UPDATE public.cargas_casadas
        SET version = version + 1, updated_at = now()
      WHERE id = $1
      RETURNING version`,
    [pacoteId],
  );
  return rows[0]?.version ?? null;
}

/**
 * Audit helper — wrapper sobre insertSecurityAuditEvent com resourceType padrao.
 */
export async function auditPacoteEvent(client, {
  eventType,
  actorUserId,
  pacoteId,
  action,
  outcome = "success",
  severity = "info",
  requestIp = null,
  correlationId = null,
  metadata = {},
}) {
  await insertSecurityAuditEvent(client, {
    eventType,
    severity,
    actorUserId,
    actorRole: "operator",
    resourceType: "cargas-casadas",
    resourceId: pacoteId,
    action,
    outcome,
    requestIp,
    correlationId,
    metadata,
  });
}

/**
 * Reseta colunas reserved_* / booked_* numa carga (uso em cancel cascade).
 */
export function buildCancelCascadeCargaUpdateSql() {
  return `
    UPDATE public.cargas
       SET status = 'CANCELLED',
           reserved_driver_id = NULL,
           reserved_claim_id = NULL,
           reserved_at = NULL,
           reserved_until = NULL,
           booked_driver_id = NULL,
           booked_at = NULL,
           updated_at = now()
     WHERE viagem_id = $1
  `;
}

/**
 * Rejeita load_claims ativos para as cargas do pacote (cancel cascade D-05).
 * Status NAO terminais: PENDING, WON_RESERVATION, WAITLISTED, PROMOTED.
 * CONFIRMED nao e tocado (motorista ja confirmou; cancelar exige outro fluxo).
 */
export async function rejectActiveClaimsForPacote(client, pacoteId, { reason = "PACOTE_CANCELLED" } = {}) {
  const { rowCount } = await client.query(
    `UPDATE public.load_claims
        SET status = 'REJECTED',
            rejected_reason = $2,
            updated_at = now()
      WHERE load_id IN (SELECT id FROM public.cargas WHERE viagem_id = $1)
        AND status IN ('PENDING', 'WON_RESERVATION', 'WAITLISTED', 'PROMOTED')`,
    [pacoteId, reason],
  );
  return rowCount;
}
