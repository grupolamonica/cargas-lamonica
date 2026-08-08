import { withPgTransaction } from "./pg/postgres.js";
import { logStructuredEvent, sanitizeLogPayload } from "./security-log.js";

function normalizeAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  return sanitizeLogPayload(metadata);
}

export async function insertSecurityAuditEvent(client, event) {
  const metadata = normalizeAuditMetadata(event.metadata);

  // actor_email sai de uma subquery no proprio INSERT (DC-283 / BX-4).
  //
  // Denormalizar a autoria no momento do fato e o que faz a trilha sobreviver a
  // exclusao do operador: `actor_user_id` tem ON DELETE SET NULL e a tela
  // resolve o nome ao vivo, entao apagar um usuario hoje anula a autoria de
  // todo o historico dele de uma vez.
  //
  // Subquery em vez de parametro novo porque sao 65 pontos de chamada: threading
  // o e-mail por todos seria invasivo pra um dado que o banco ja tem a mao, sem
  // round-trip extra. Ator nulo (evento de sistema) devolve NULL.
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
        metadata,
        actor_email
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        (SELECT email FROM auth.users WHERE id = $3)
      )
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

