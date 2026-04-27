import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { TERMINAL_LOAD_STATUSES } from "./_shared.js";

export async function redactExpiredPublicLeadPii({ batchSize = 50, retentionDays = 30, correlationId }) {
  const effectiveBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 50;
  const effectiveRetentionDays = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
  const cutoffTimestamp = new Date(Date.now() - effectiveRetentionDays * 24 * 60 * 60 * 1000).toISOString();

  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `
        SELECT leads.id
        FROM public.load_public_leads AS leads
        INNER JOIN public.cargas ON cargas.id = leads.load_id
        WHERE leads.pii_redacted_at IS NULL
          AND leads.status IN ('APPROVED', 'CANCELLED')
          AND (
            leads.status = 'CANCELLED'
            OR cargas.status = ANY($1::text[])
          )
          AND COALESCE(leads.approved_at, leads.updated_at, leads.created_at) < $2::timestamptz
        ORDER BY COALESCE(leads.approved_at, leads.updated_at, leads.created_at) ASC
        LIMIT $3
        FOR UPDATE
      `,
      [TERMINAL_LOAD_STATUSES, cutoffTimestamp, effectiveBatchSize],
    );

    if (!rows.length) return { redactedCount: 0, correlationId };

    const leadIds = rows.map((row) => row.id);
    const placeholderSql = leadIds.map((_, index) => `$${index + 1}`).join(", ");

    await client.query(
      `
        UPDATE public.load_public_leads
        SET
          cpf = CONCAT('redacted-cpf-', id::text),
          phone = CONCAT('redacted-phone-', id::text),
          horse_plate = CONCAT('redacted-horse-', id::text),
          trailer_plate = CONCAT('redacted-trailer-', id::text),
          trailer_plate_2 = CASE
            WHEN COALESCE(trailer_plate_2, '') = '' THEN ''
            ELSE CONCAT('redacted-trailer-2-', id::text)
          END,
          pii_redacted_at = now()
        WHERE id IN (${placeholderSql})
      `,
      leadIds,
    );

    await insertSecurityAuditEvent(client, {
      eventType: "public-leads.pii.redacted",
      actorRole: "system",
      resourceType: "public-load-lead",
      action: "redact-pii",
      outcome: "success",
      correlationId,
      metadata: { redactedCount: leadIds.length, retentionDays: effectiveRetentionDays },
    });

    return { redactedCount: leadIds.length, correlationId };
  });
}
