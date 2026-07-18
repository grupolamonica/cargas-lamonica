/**
 * driver-outreach — worker que drena a fila pending_driver_outreach e envia via
 * Evolution API (Wave B). Guardrails (nesta ordem):
 *   1. kill-switch (DRIVER_OUTREACH_ENABLED)
 *   2. Evolution configurado (token)
 *   3. janela de horário (quiet hours)
 *   4. cap diário (rolling 24h, contado em driver_outreach_log)
 *   5. opt-out por motorista
 *   6. gatilho frio exige DRIVER_OUTREACH_COLD_ENABLED
 * Retry com backoff; circuito aberto NÃO consome tentativa.
 */

import { withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import {
  EvolutionCircuitOpenError,
  MissingConfigError,
  RecipientNotAllowedError,
  sendWhatsappText,
} from "../../infrastructure/whatsapp/evolution-client.js";
import {
  backoffMs,
  effectiveDailyCap,
  getOutreachConfig,
  isTriggerAllowed,
  isWithinSendWindow,
  pickTypingDelayMs,
} from "./config.js";

function isEvolutionConfigured() {
  return Boolean((process.env.EVOLUTION_API_TOKEN || "").trim());
}

async function sentInLast24h(client, nowMs) {
  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM public.driver_outreach_log
      WHERE channel = 'evolution' AND status = 'sent' AND created_at > $1`,
    [cutoff],
  );
  return Number(rows[0]?.n ?? 0);
}

async function sentInLastHour(client, nowMs) {
  const cutoff = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM public.driver_outreach_log
      WHERE channel = 'evolution' AND status = 'sent' AND created_at > $1`,
    [cutoff],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Dias decorridos desde o primeiro envio bem-sucedido (para o warmup). */
async function daysSinceFirstSend(client, nowMs) {
  const { rows } = await client.query(
    `SELECT min(created_at) AS first FROM public.driver_outreach_log
      WHERE channel = 'evolution' AND status = 'sent'`,
  );
  const first = rows[0]?.first ? new Date(rows[0].first).getTime() : null;
  if (!first) return 0;
  return Math.floor((nowMs - first) / (24 * 60 * 60 * 1000));
}

async function isOptedOut(client, driverKey) {
  const { rows } = await client.query(
    `SELECT 1 FROM public.driver_outreach_optout WHERE driver_key = $1 LIMIT 1`,
    [driverKey],
  );
  return rows.length > 0;
}

async function logOutreach(client, row, status, error) {
  await client.query(
    `INSERT INTO public.driver_outreach_log (driver_key, trigger, channel, status, phone, correlation_id, payload)
     VALUES ($1, $2, 'evolution', $3, $4, $5, $6::jsonb)`,
    [row.driver_key, row.trigger, status, row.phone, row.correlation_id || null,
     JSON.stringify(error ? { error: String(error).slice(0, 200) } : {})],
  );
}

/**
 * Processa um ciclo da fila. Retorna contadores. Não lança — falhas ficam
 * registradas na própria linha (retry/failed).
 * @returns {Promise<{sent:number,failed:number,skipped:number,reason?:string}>}
 */
/**
 * Gatilhos TRANSACIONAIS — bypass dos gates de config (enabled/quiet/cap).
 * São reações a ações do próprio operador/motorista (ex.: reserva de carga),
 * NÃO envio proativo/promocional. Sempre entregam quando Evolution está
 * configurado; ainda respeitam opt-out e circuit breaker.
 */
function isTransactionalTrigger(trigger) {
  return String(trigger || "").startsWith("reservation:");
}

export async function processOutreachQueue({ now = new Date() } = {}) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  const nowMs = now.getTime();

  return withPgTransaction(async (client) => {
    const cfg = await getOutreachConfig(client);
    if (!isEvolutionConfigured()) return { ...result, reason: "evolution_not_configured" };

    // Gates que se aplicam SÓ ao outreach (não-transacional).
    const outreachGate =
      cfg.enabled && isWithinSendWindow(cfg, now)
        ? { allowed: true }
        : { allowed: false, reason: cfg.enabled ? "quiet_hours" : "disabled" };

    const alreadySent = await sentInLast24h(client, nowMs);
    const sentThisHour = await sentInLastHour(client, nowMs);
    const daysWarm = cfg.warmupEnabled ? await daysSinceFirstSend(client, nowMs) : 0;
    const dailyCapEff = effectiveDailyCap(cfg, daysWarm);
    // Cap só limita OUTREACH; transacional bypassa. Aplica o MENOR entre o que
    // resta no dia (com warmup) e o que resta na hora.
    let outreachRemaining = Math.min(
      Math.max(0, dailyCapEff - alreadySent),
      Math.max(0, cfg.hourlyCap - sentThisHour),
    );
    // Limite de envios PROATIVOS por ciclo (anti-rajada em backlog).
    let cycleRemaining = Math.max(1, cfg.sendsPerCycle);

    const nowIso = now.toISOString();
    const { rows } = await client.query(
      `SELECT id, driver_key, trigger, phone, message, correlation_id, retry_count
         FROM public.pending_driver_outreach
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE`,
      [nowIso, cfg.batchSize],
    );

    // Se nem transacional nem outreach podem enviar, sinaliza motivo.
    if (rows.length === 0 && !outreachGate.allowed) return { ...result, reason: outreachGate.reason };

    for (const row of rows) {
      const transactional = isTransactionalTrigger(row.trigger);

      // opt-out sempre respeitado (incluindo transacional).
      if (await isOptedOut(client, row.driver_key)) {
        await client.query(
          `UPDATE public.pending_driver_outreach SET status='skipped', last_error='opted_out' WHERE id=$1`,
          [row.id],
        );
        await logOutreach(client, row, "skipped", "opted_out");
        result.skipped += 1;
        continue;
      }

      // Gates de outreach só se aplicam ao NÃO-transacional.
      if (!transactional) {
        if (!outreachGate.allowed) {
          // Não pula (respeita quiet/kill-switch): apenas atrasa 5 min.
          await client.query(
            `UPDATE public.pending_driver_outreach SET next_attempt_at=$2 WHERE id=$1`,
            [row.id, new Date(nowMs + 5 * 60 * 1000).toISOString()],
          );
          continue;
        }
        if (outreachRemaining <= 0) {
          await client.query(
            `UPDATE public.pending_driver_outreach SET next_attempt_at=$2 WHERE id=$1`,
            [row.id, new Date(nowMs + 60 * 60 * 1000).toISOString()],
          );
          continue;
        }
        // Anti-rajada: no máximo `sendsPerCycle` envios proativos por ciclo.
        // O restante do backlog fica para o próximo poll (respeita o drip).
        if (cycleRemaining <= 0) {
          await client.query(
            `UPDATE public.pending_driver_outreach SET next_attempt_at=$2 WHERE id=$1`,
            [row.id, new Date(nowMs + Math.max(10, cfg.pollSeconds) * 1000).toISOString()],
          );
          continue;
        }
        if (!isTriggerAllowed(row.trigger, cfg)) {
          await client.query(
            `UPDATE public.pending_driver_outreach SET status='skipped', last_error='cold_disabled' WHERE id=$1`,
            [row.id],
          );
          result.skipped += 1;
          continue;
        }
      }

      try {
        // "Digitando…" com jitter — só para envio proativo. Transacional
        // (resposta a ação do operador/motorista) sai direto, sem simulação.
        const delayMs = transactional ? 0 : pickTypingDelayMs(cfg);
        await sendWhatsappText({
          to: row.phone,
          text: row.message,
          correlationId: row.correlation_id,
          delayMs,
        });
        await client.query(
          `UPDATE public.pending_driver_outreach SET status='sent', sent_at=$2 WHERE id=$1`,
          [row.id, nowIso],
        );
        await logOutreach(client, row, "sent", null);
        result.sent += 1;
        if (!transactional) {
          outreachRemaining -= 1;
          cycleRemaining -= 1;
        }
      } catch (error) {
        if (error instanceof RecipientNotAllowedError) {
          // Bloqueado pela allowlist de teste — consome como skipped, sem retry.
          await client.query(
            `UPDATE public.pending_driver_outreach SET status='skipped', last_error='not_in_test_allowlist' WHERE id=$1`,
            [row.id],
          );
          await logOutreach(client, row, "skipped", "not_in_test_allowlist");
          result.skipped += 1;
          continue;
        }
        if (error instanceof EvolutionCircuitOpenError || error instanceof MissingConfigError) {
          // Não consome tentativa: reprograma e para o ciclo (outage transitório).
          await client.query(
            `UPDATE public.pending_driver_outreach SET next_attempt_at=$2 WHERE id=$1`,
            [row.id, new Date(nowMs + 60_000).toISOString()],
          );
          break;
        }
        const attempts = Number(row.retry_count) + 1;
        if (attempts >= cfg.maxAttempts) {
          await client.query(
            `UPDATE public.pending_driver_outreach
               SET status='failed', retry_count=$2, last_error=$3 WHERE id=$1`,
            [row.id, attempts, String(error).slice(0, 300)],
          );
          await logOutreach(client, row, "failed", error);
          result.failed += 1;
        } else {
          await client.query(
            `UPDATE public.pending_driver_outreach
               SET retry_count=$2, last_error=$3, next_attempt_at=$4 WHERE id=$1`,
            [row.id, attempts, String(error).slice(0, 300), new Date(nowMs + backoffMs(attempts)).toISOString()],
          );
        }
      }
    }

    if (result.sent || result.failed || result.skipped) {
      logStructuredEvent("info", "driver-outreach.queue.processed", result);
    }
    return result;
  });
}
