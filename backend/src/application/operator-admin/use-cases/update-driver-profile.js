import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { buildAuditChanges } from "../../../domain/operator-admin/audit-diff.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";

// Rótulos pt-BR dos campos editáveis do motorista (DC-184, antes → depois).
const DRIVER_FIELD_LABELS = {
  full_name: "Nome", phone: "Telefone", document_number: "CPF",
  vehicle_profile: "Perfil do veículo", documents_valid: "Documentos válidos",
  antt_valid: "ANTT válida", tracking_enabled: "Rastreamento",
  insurance_valid: "Seguro válido", monitoring_capable: "Carga monitorada",
  operational_blocked: "Bloqueado", allowed_regions: "Regiões permitidas",
};

export async function updateOperatorDriverProfile({ driverId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    // SELECT * p/ capturar o estado anterior de qualquer campo editável (DC-184).
    const { rows } = await client.query(
      `SELECT * FROM public.driver_profiles WHERE user_id = $1 FOR UPDATE`,
      [driverId],
    );

    if (!rows[0]) throw new NotFoundError("Motorista nao encontrado.");

    const before = rows[0];
    const oldCpf = String(before.document_number || "").replace(/\D/g, "");
    const oldPhone = String(before.phone || "").replace(/\D/g, "");

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

    // Diff só dos campos presentes no payload (update parcial). Array text[] é
    // comparado como string ordenada p/ o antes/depois ficar legível.
    // CPF e telefone ficam FORA do antes/depois: são PII e o array vai em
    // {metadata.changes} sob chaves genéricas (before/after) que o
    // sanitizeLogPayload não redige. Continuam sinalizados em updatedFields.
    const PII_FIELDS = new Set(["document_number", "phone"]);
    const changeBefore = {};
    const changeAfter = {};
    const changeFields = [];
    const asComparable = (v) => (Array.isArray(v) ? [...v].sort().join(", ") : v);

    for (const [payloadKey, column] of Object.entries(fieldMap)) {
      if (payload[payloadKey] !== undefined) {
        const isArrayColumn = column === "allowed_regions";
        const rawValue = payload[payloadKey];
        const normalizedValue = column === "phone" ? String(rawValue || "").replace(/\D/g, "") : rawValue;
        updates.push(`${column} = $${paramIndex}${isArrayColumn ? "::text[]" : ""}`);
        values.push(normalizedValue);
        paramIndex++;

        if (!PII_FIELDS.has(payloadKey)) {
          changeBefore[payloadKey] = asComparable(before[column]);
          changeAfter[payloadKey] = asComparable(normalizedValue);
          changeFields.push({ key: payloadKey, label: DRIVER_FIELD_LABELS[payloadKey] || payloadKey });
        }
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
      metadata: {
        updatedFields: Object.keys(payload),
        previousName: before.full_name,
        changes: buildAuditChanges(changeBefore, changeAfter, changeFields),
      },
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
