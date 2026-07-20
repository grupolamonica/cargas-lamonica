import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

// DC-260 — "Check Rodopar": marca por carga se já foi lançada no Rodopar.
//   0 = não lançado (vermelho) · 1 = lançado (preto) · 2 = lançado incorreto (azul)
//
// Funciona p/ QUALQUER linha do Monitor: carga da planilha (id determinístico via
// createSheetLoadId(lh)) OU carga do sistema (cargoId direto). Persiste só
// rodopar_status (+ metadados) — ortogonal a alloc_*, então NÃO seta alloc_updated_at
// (não é edição de alocação). O sync da planilha nunca toca este campo.

const VALID = new Set([0, 1, 2]);

/**
 * @param {{ lh?: string, cargoId?: string, status: number, operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function setMonitorRodoparStatus({ lh, cargoId, status, operatorId, requestIp, correlationId }) {
  const value = Number(status);
  if (!VALID.has(value)) {
    throw new ValidationError("Status Rodopar inválido (use 0=não lançado, 1=lançado, 2=lançado incorreto).");
  }
  const lhTrim = String(lh ?? "").trim();
  const id = String(cargoId ?? "").trim() || (lhTrim ? createSheetLoadId(lhTrim) : "");
  if (!id) {
    throw new ValidationError("Informe cargoId (carga do sistema) ou lh (carga da planilha).");
  }

  return withPgTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id FROM public.cargas WHERE id = $1 FOR UPDATE`, [id]);
    if (rows.length === 0) {
      throw new NotFoundError("Carga não encontrada para atualizar o status do Rodopar.");
    }

    await client.query(
      `UPDATE public.cargas
          SET rodopar_status = $2,
              rodopar_updated_at = now(),
              rodopar_updated_by = $3::uuid,
              updated_at = now()
        WHERE id = $1`,
      [id, value, operatorId],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.rodopar_status_changed",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: id,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { lh: lhTrim || null, cargoId: cargoId ?? null, rodoparStatus: value },
    });

    return {
      statusCode: 200,
      payload: { ok: true, cargoId: id, lh: lhTrim || null, rodoparStatus: value, meta: { correlationId } },
    };
  });
}
