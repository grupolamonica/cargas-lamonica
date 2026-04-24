import { withPgTransaction } from "./postgres.js";
import { logStructuredEvent, sanitizeLogPayload } from "./security-log.js";

function normalizeAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  return sanitizeLogPayload(metadata);
}

export async function insertSecurityAuditEvent(client, event) {
  const metadata = normalizeAuditMetadata(event.metadata);

  await client.query(
    `
      INSERT INTO public.security_audit_logs (
        event_type,
        severity,
        actor_user_id,
        actor_role,
        resource_type,
        resource_id,
        action,
        outcome,
        request_ip,
        correlation_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    `,
    [
      event.eventType,
      event.severity || "info",
      event.actorUserId || null,
      event.actorRole || null,
      event.resourceType || null,
      event.resourceId || null,
      event.action || null,
      event.outcome,
      event.requestIp || null,
      event.correlationId || null,
      JSON.stringify(metadata),
    ],
  );
}

export async function recordSecurityAuditEvent(event) {
  try {
    await withPgTransaction(async (client) => {
      await insertSecurityAuditEvent(client, event);
    });
  } catch (error) {
    logStructuredEvent("error", "security-audit.write_failed", {
      eventType: event.eventType,
      correlationId: event.correlationId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

