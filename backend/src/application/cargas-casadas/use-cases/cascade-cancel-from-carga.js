/**
 * cascade-cancel-from-carga — Cascade reverso (D-05 LOCKED).
 *
 * Quando o operador cancela uma carga individual que pertence a pacote
 * (cargas.viagem_id NOT NULL), a regra de negocio LOCKED em CONTEXT.md exige:
 *  - Pacote -> 'cancelado'
 *  - TODAS as cargas-irmas -> 'CANCELLED' (mesmo as que ainda estavam abertas)
 *  - load_claims ativos -> 'REJECTED' (reason='PACOTE_CARGA_CANCELLED')
 *
 * Tudo em UMA transacao. Sem cascade parcial.
 *
 * Lock order (consistente com atomic-claim para evitar deadlock — T-10-15):
 *   1. cargas (FOR UPDATE) — alvo do cancel
 *   2. cargas_casadas (FOR UPDATE) — pacote
 *   3. demais cargas do pacote (via invalidatePendingClaimsForPacote +
 *      buildCancelCascadeCargaUpdateSql)
 *
 * Backward-compat: caller (operator-admin handler) deve checar viagem_id antes
 * de invocar esta funcao. Se a carga e avulsa, caller segue o fluxo padrao
 * (UPDATE direto em cargas.status='CANCELLED') — esta funcao nao se aplica.
 */

import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  NotFoundError,
  ValidationError,
} from "../../../domain/load-claims/errors.js";
import {
  buildCancelCascadeCargaUpdateSql,
  selectPacoteForUpdate,
} from "./_shared.js";
import { invalidatePendingClaimsForPacote } from "./invalidate-pending-claims.js";

/**
 * @param {object} params
 * @param {string} params.cargaId - UUID da carga que disparou o cancel
 * @param {string} params.operatorId - UUID do operador
 * @param {string} [params.reason='OPERATOR_CANCELLED_CARGA']
 * @param {string} [params.requestIp]
 * @param {string} [params.correlationId]
 *
 * @returns {Promise<{
 *   pacoteId: string,
 *   cancelledCargaIds: string[],
 *   invalidatedClaimIds: string[],
 *   alreadyCancelled?: boolean,
 * }>}
 */
export async function cascadeCancelFromCarga({
  cargaId,
  operatorId,
  reason = "OPERATOR_CANCELLED_CARGA",
  requestIp,
  correlationId,
}) {
  const result = await withPgTransaction(async (client) => {
    // 1. Lock carga origem.
    const { rows: cargaRows } = await client.query(
      `SELECT id, status, viagem_id, ordem_viagem
         FROM public.cargas
        WHERE id = $1
        FOR UPDATE`,
      [cargaId],
    );
    const carga = cargaRows[0];
    if (!carga) {
      throw new NotFoundError("Carga nao encontrada.");
    }
    if (!carga.viagem_id) {
      throw new ValidationError(
        "Carga nao pertence a pacote — cascade nao se aplica.",
        { code: "carga_sem_pacote", cargaId },
      );
    }

    const pacoteId = carga.viagem_id;

    // 2. Lock pacote.
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    // Idempotencia: se ja cancelado, no-op.
    if (pacote.status === "cancelado") {
      return {
        pacoteId,
        cancelledCargaIds: [],
        invalidatedClaimIds: [],
        alreadyCancelled: true,
      };
    }

    // 3. Invalida claims ativos do pacote (reason especifico de cascade reverso).
    //    Tambem libera reservas em cargas (status RESERVED -> OPEN), mas em seguida
    //    todas as cargas serao marcadas como CANCELLED, entao o estado transitorio
    //    'OPEN' nao e observavel fora da transacao.
    const { invalidatedClaimIds } = await invalidatePendingClaimsForPacote(
      client,
      pacoteId,
      "PACOTE_CARGA_CANCELLED",
    );

    // 4. Cascade: todas as cargas do pacote -> CANCELLED.
    const { rows: cancelledCargas } = await client.query(
      `${buildCancelCascadeCargaUpdateSql()} RETURNING id`,
      [pacoteId],
    );

    // 5. Pacote -> cancelado.
    await client.query(
      `UPDATE public.cargas_casadas
          SET status = 'cancelado',
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [pacoteId],
    );

    // 6. Audit (dentro da transacao).
    await insertSecurityAuditEvent(client, {
      eventType: "operator.pacote.cascade_cancelled",
      severity: "warn",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargas-casadas",
      resourceId: pacoteId,
      action: "cascade-cancel-from-carga",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        triggerCargaId: cargaId,
        reason,
        cancelledCargaIds: cancelledCargas.map((c) => c.id),
        invalidatedClaimIds,
      },
    });

    return {
      pacoteId,
      cancelledCargaIds: cancelledCargas.map((c) => c.id),
      invalidatedClaimIds,
    };
  });

  return result;
}
