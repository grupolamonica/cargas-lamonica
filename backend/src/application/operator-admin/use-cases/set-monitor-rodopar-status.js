import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";

// DC-260 — "Check Rodopar": marca por LH da linha do Monitor se já foi lançada no
// Rodopar. 0 = não lançado (vermelho) · 1 = lançado (preto) · 2 = lançado incorreto (azul).
//
// Guardado por LH em monitor_rodopar_status (NÃO em cargas): o Monitor é a visão da
// planilha e a maioria das linhas NÃO tem carga (createSheetLoadId sem match — dava
// "Carga não encontrada"). Upsert idempotente por LH — funciona p/ qualquer linha do
// Monitor, exista carga ou não, sem poluir a tabela cargas / o portal.

const VALID = new Set([0, 1, 2]);

/**
 * @param {{ lh: string, status: number, operatorId: string, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function setMonitorRodoparStatus({ lh, status, operatorId, requestIp, correlationId }) {
  const value = Number(status);
  if (!VALID.has(value)) {
    throw new ValidationError("Status Rodopar inválido (use 0=não lançado, 1=lançado, 2=lançado incorreto).");
  }
  const key = String(lh ?? "").trim();
  if (!key) {
    throw new ValidationError("LH da linha é obrigatório para o Check Rodopar.");
  }

  return withPgTransaction(async (client) => {
    await client.query(
      `INSERT INTO public.monitor_rodopar_status (lh, status, updated_at, updated_by)
       VALUES ($1, $2, now(), $3::uuid)
       ON CONFLICT (lh) DO UPDATE
         SET status = EXCLUDED.status, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, value, operatorId],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.rodopar_status_changed",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "monitor_rodopar",
      resourceId: key,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { lh: key, rodoparStatus: value },
    });

    return {
      statusCode: 200,
      payload: { ok: true, lh: key, rodoparStatus: value, meta: { correlationId } },
    };
  });
}
