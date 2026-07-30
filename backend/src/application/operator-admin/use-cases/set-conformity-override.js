import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import { normalizeSubjectKey } from "../conformity-overrides.js";

/**
 * Define (ou limpa) o verdito MANUAL de conformidade Angellira de uma entidade
 * (motorista por CPF, veículo por placa), setado no modal da carga do Monitor.
 *
 * - decision "APPROVED"/"NOT_APPROVED" → UPSERT com observação OBRIGATÓRIA (não-vazia);
 * - decision null → LIMPA (DELETE) o verdito → volta ao selo Angellira derivado.
 *
 * É um SELO VISUAL (não bloqueia operação). Chaveado por entidade → vale em todas as
 * cargas do motorista/veículo e sobrevive ao re-enriquecimento (o Monitor aplica o
 * overlay em read-time, não persiste no enriched).
 *
 * @param {{ subjectType:'DRIVER'|'VEHICLE', subjectKey:string, decision:('APPROVED'|'NOT_APPROVED'|null),
 *          observacao?:string, operatorId:string, operatorName?:string|null,
 *          requestIp?:string, correlationId?:string }} args
 */
export async function setConformityOverride({
  subjectType,
  subjectKey,
  decision,
  observacao,
  operatorId,
  operatorName = null,
  requestIp,
  correlationId,
}) {
  const key = normalizeSubjectKey(subjectType, subjectKey);
  if (!key) {
    throw new ValidationError("Identidade da entidade (CPF/placa) ausente ou inválida.");
  }
  // Id do recurso p/ o audit log: mascara o CPF do motorista (LGPD — não persiste
  // CPF cru no security_audit_logs / CSV do DC-186; convenção `***NNN` do DC-310).
  // A placa do veículo não é PII sensível e vai crua. O CPF completo fica só na
  // tabela angellira_conformity_overrides.subject_key.
  const auditResourceId =
    subjectType === "DRIVER" ? (key.length >= 3 ? `***${key.slice(-3)}` : "***") : key;
  const clearing = decision === null || decision === undefined;
  const obs = (observacao ?? "").toString().trim();
  // Enforcement autoritativo (além do zod): observação obrigatória ao aprovar/reprovar.
  if (!clearing && obs.length === 0) {
    throw new ValidationError("Informe uma observação para registrar a conformidade.");
  }

  return withPgTransaction(async (client) => {
    if (clearing) {
      const { rows } = await client.query(
        `DELETE FROM public.angellira_conformity_overrides
         WHERE subject_type = $1 AND subject_key = $2
         RETURNING decision`,
        [subjectType, key],
      );
      await insertSecurityAuditEvent(client, {
        eventType: "operator.monitor.conformity_override_clear",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: subjectType === "DRIVER" ? "driver" : "vehicle",
        resourceId: auditResourceId,
        action: "update",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { subjectType, previousDecision: rows[0]?.decision ?? null },
      });
      return { statusCode: 200, payload: { ok: true, cleared: true, meta: { correlationId } } };
    }

    await client.query(
      `INSERT INTO public.angellira_conformity_overrides
         (subject_type, subject_key, decision, observacao, set_by, set_by_name, set_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (subject_type, subject_key) DO UPDATE
         SET decision = EXCLUDED.decision,
             observacao = EXCLUDED.observacao,
             set_by = EXCLUDED.set_by,
             set_by_name = EXCLUDED.set_by_name,
             updated_at = now()`,
      [subjectType, key, decision, obs, operatorId, operatorName],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.monitor.conformity_override",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: subjectType === "DRIVER" ? "driver" : "vehicle",
      resourceId: auditResourceId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      // observacao NÃO vai no metadata (texto livre = pode ter PII; fica só na tabela).
      metadata: { subjectType, decision },
    });

    return {
      statusCode: 200,
      payload: { ok: true, subjectType, decision, meta: { correlationId } },
    };
  });
}
