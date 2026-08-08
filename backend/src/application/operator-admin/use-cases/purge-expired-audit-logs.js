import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

/**
 * Expurgo por retenção da trilha de auditoria (DC-283 / MED-9).
 *
 * `security_audit_logs` guarda dado pessoal — IP da requisição, e-mail do ator
 * (denormalizado no BX-4), nome de motorista dentro de `metadata.moves`. O
 * comentário do índice já dizia 90 dias, mas nunca houve job: a trilha crescia
 * para sempre, recriando dentro da auditoria o mesmo problema de retenção
 * indefinida que o CRIT-4 apontou na base.
 *
 * Tensão real deste job: retenção curta demais destrói a capacidade de
 * investigar; longa demais é retenção indefinida com outro nome. 90 dias é o
 * número que já estava escrito no schema — não uma política aprovada. Trocar é
 * mudar `AUDIT_LOG_RETENTION_DAYS`.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_AUDIT_PURGE_BATCH = 500;
export const AUDIT_PURGE_MODES = ["off", "report", "on"];

/**
 * Default `report` — mesma escolha do expurgo de rascunhos (CRIT-4) e pelo mesmo
 * motivo: é um expurgo de estreia, enfrenta todo o acumulado histórico no
 * primeiro ciclo, e o que apaga não volta.
 */
export function resolveAuditPurgeMode(rawValue = process.env.AUDIT_LOG_PURGE_MODE) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  return AUDIT_PURGE_MODES.includes(normalized) ? normalized : "report";
}

/**
 * @param {object} [options]
 * @param {number} [options.retentionDays]
 * @param {number} [options.limit] Teto por ciclo — o primeiro ciclo pode ter
 *   centenas de milhares de linhas elegíveis, e um DELETE único seguraria a
 *   tabela que TODA escrita de auditoria usa.
 * @param {boolean} [options.dryRun] Só conta.
 */
export async function purgeExpiredAuditLogs({
  retentionDays = DEFAULT_AUDIT_RETENTION_DAYS,
  limit = DEFAULT_AUDIT_PURGE_BATCH,
  dryRun = false,
  correlationId,
} = {}) {
  const dias = Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : DEFAULT_AUDIT_RETENTION_DAYS;
  const lote = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_AUDIT_PURGE_BATCH;
  const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  return withPgTransaction(async (client) => {
    if (dryRun) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS elegiveis FROM public.security_audit_logs WHERE created_at < $1::timestamptz`,
        [cutoff],
      );
      return { deletedCount: 0, eligibleCount: rows[0]?.elegiveis || 0, cutoff, dryRun: true };
    }

    // A trilha é append-only por trigger (ALTO-15). Esta é a ÚNICA remoção
    // legítima e precisa se declarar — sem isto o DELETE abaixo levanta exceção,
    // que é exatamente o comportamento desejado para qualquer outro caminho.
    await client.query("SET LOCAL app.audit_purge = 'on'");

    const { rowCount } = await client.query(
      `
        DELETE FROM public.security_audit_logs
        WHERE id IN (
          SELECT id FROM public.security_audit_logs
          WHERE created_at < $1::timestamptz
          ORDER BY created_at ASC
          LIMIT $2
        )
      `,
      [cutoff, lote],
    );

    const deletedCount = rowCount || 0;

    if (deletedCount > 0) {
      // Apagar trilha é ato auditável. O evento fica na própria tabela e um dia
      // será expurgado também — o que registra é QUE houve expurgo e quanto,
      // não o conteúdo apagado.
      await insertSecurityAuditEvent(client, {
        eventType: "security-audit.retention.purged",
        severity: "info",
        actorRole: "system",
        resourceType: "security_audit_logs",
        action: "purge-by-retention",
        outcome: "success",
        correlationId,
        metadata: { deletedCount, retentionDays: dias, cutoff },
      });
    }

    return { deletedCount, eligibleCount: null, cutoff, dryRun: false };
  });
}
