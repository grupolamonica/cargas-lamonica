import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";

export async function updateOperatorDriverProfile({ driverId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT user_id, full_name, document_number, phone FROM public.driver_profiles WHERE user_id = $1 FOR UPDATE`,
      [driverId],
    );

    if (!rows[0]) throw new NotFoundError("Motorista nao encontrado.");

    const oldCpf = String(rows[0].document_number || "").replace(/\D/g, "");
    const oldPhone = String(rows[0].phone || "").replace(/\D/g, "");

    const updates = [];
    const values = [driverId];
    let paramIndex = 2;

    const fieldMap = {
      full_name: "full_name", phone: "phone", document_number: "document_number",
      vehicle_profile: "vehicle_profile", documents_valid: "documents_valid",
      antt_valid: "antt_valid", tracking_enabled: "tracking_enabled",
      insurance_valid: "insurance_valid", monitoring_capable: "monitoring_capable",
      operational_blocked: "operational_blocked", allowed_regions: "allowed_regions",
    };

    for (const [payloadKey, column] of Object.entries(fieldMap)) {
      if (payload[payloadKey] !== undefined) {
        const isArrayColumn = column === "allowed_regions";
        const rawValue = payload[payloadKey];
        const normalizedValue = column === "phone" ? String(rawValue || "").replace(/\D/g, "") : rawValue;
        updates.push(`${column} = $${paramIndex}${isArrayColumn ? "::text[]" : ""}`);
        values.push(normalizedValue);
        paramIndex++;
      }
    }

    if (updates.length === 0) throw new ValidationError("Nenhum campo informado para atualizar.");

    updates.push("updated_at = now()");

    await client.query(
      `UPDATE public.driver_profiles SET ${updates.join(", ")} WHERE user_id = $1`,
      values,
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.driver.profile.updated",
      severity: "info",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "driver_profile",
      resourceId: driverId,
      action: "update-driver-profile",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: { updatedFields: Object.keys(payload), previousName: rows[0].full_name },
    });

    logStructuredEvent("info", "operator.driver.profile.updated", {
      driverId, operatorId, correlationId, updatedFields: Object.keys(payload),
    });

    const newCpf = payload.document_number !== undefined
      ? String(payload.document_number || "").replace(/\D/g, "")
      : oldCpf;
    const newPhone = payload.phone !== undefined
      ? String(payload.phone || "").replace(/\D/g, "")
      : oldPhone;

    if (oldCpf && oldCpf !== newCpf) {
      await client.query(
        `UPDATE public.load_public_leads SET cpf = $1 WHERE REGEXP_REPLACE(cpf, '\\D', '', 'g') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newCpf, oldCpf],
      );
    }
    if (oldPhone && oldPhone !== newPhone) {
      await client.query(
        `UPDATE public.load_public_leads SET phone = $1 WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newPhone, oldPhone],
      );
    }

    const { rows: updatedRows } = await client.query(
      `SELECT * FROM public.driver_profiles WHERE user_id = $1`,
      [driverId],
    );

    return {
      statusCode: 200,
      payload: { ok: true, profile: updatedRows[0], meta: { correlationId } },
    };
  });
}
