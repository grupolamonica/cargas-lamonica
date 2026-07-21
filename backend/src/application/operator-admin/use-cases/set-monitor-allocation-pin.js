import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { resolveMonitorCargoByLh } from "./_shared.js";

/**
 * Fixa ("fixo") ou desafixa a alocação de uma carga do Monitor. Uma carga fixada
 * tem o motorista/veículo INTOCÁVEL: não pode ser movido por arrasto (reassign),
 * nem ter motorista/veículo editado (inline/modal), nem ser remanejado pela
 * cascata de cancelamento da rota. É a decisão do operador de que aquele
 * motorista está garantido naquela viagem.
 *
 * Persiste só `alloc_pinned` (+ metadados); o sync da planilha NUNCA toca alloc_*,
 * então o "fixo" é durável. Não há write-back: a planilha não tem conceito de fixo.
 *
 * @param {{ lh: string, pinned: boolean, operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function setMonitorAllocationPin({ lh, pinned, operatorId, requestIp, correlationId }) {
  const isPinned = Boolean(pinned);

  return withPgTransaction(async (client) => {
    // Resolve por id da PLANILHA OU por lh_manual (carga do sistema lançada na
    // Programação) — mesma resolução do updateMonitorAllocation, senão fixar/
    // desafixar uma carga lançada falhava com "Carga da planilha não encontrada".
    const row = await resolveMonitorCargoByLh(client, lh, { columns: "id, sheet_lh" });
    if (!row) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }
    const cargoId = row.id;

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_pinned = $2,
            alloc_pinned_at = CASE WHEN $2 THEN now() ELSE NULL END,
            alloc_pinned_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            alloc_source = 'operator',
            alloc_updated_at = now(),
            alloc_updated_by = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [cargoId, isPinned, operatorId],
    );

    await insertSecurityAuditEvent(client, {
      eventType: isPinned ? "operator.cargo.allocation_pinned" : "operator.cargo.allocation_unpinned",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { lh, pinned: isPinned },
    });

    return {
      statusCode: 200,
      payload: { ok: true, lh, pinned: isPinned, meta: { correlationId } },
    };
  });
}
