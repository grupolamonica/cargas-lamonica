// Auto-aprovação de cadastros PENDENTES quando o motorista está vigente no
// Angellira. É a versão "produto" do que foi feito em lote manualmente:
// consulta a vigência do motorista (por CPF) via o cliente Angellira e, para
// os vigentes (status FOUND + validade >= hoje), muda SÓ o status para
// 'aprovado' (fluxo leve — NÃO cria login/driver_profile). Reversível pelo
// marcador `reviewed_by_id = AUTO_APPROVE_MARKER`.
//
// É session-independent de propósito: pode ser chamado tanto pelo endpoint do
// operador (botão "rodar agora") quanto pelo job em background no main.js.
import { withPgClient } from "../../../../infrastructure/pg/postgres.js";
import { lookupAngelliraDriverByCpf } from "../../../../infrastructure/angellira/angellira-client.js";
import { insertSecurityAuditEvent } from "../../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

export const AUTO_APPROVE_SETTING_KEY = "auto_approve_angellira";
// Mesmo marcador usado na aprovação em lote de 09/07/2026 — permite reverter
// filtrando por reviewed_by_id.
export const AUTO_APPROVE_MARKER = "auto:angellira-vigencia";

const DEFAULT_BATCH = 25;
const PACING_MS = 250;

// Guard de reentrância compartilhado (módulo ESM é singleton no processo):
// impede que o job periódico e o botão "rodar agora" rodem ao mesmo tempo.
let running = false;
export function isAutoApproveRunning() {
  return running;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Data de hoje (YYYY-MM-DD) no fuso de São Paulo — mesma régua da vigência. */
function todaySaoPaulo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Cria a tabela de settings se não existir (idempotente; espelha analytics_events no bootstrap). */
export async function ensureAppSettingsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    )
  `);
}

/** Lê o setting do auto-approve. Default: desligado, sem última execução. */
export async function getAutoApproveSetting() {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    const { rows } = await client.query(
      `SELECT value FROM public.app_settings WHERE key = $1`,
      [AUTO_APPROVE_SETTING_KEY],
    );
    const value = rows[0]?.value || {};
    return {
      enabled: Boolean(value.enabled),
      lastRun: value.lastRun || null,
    };
  });
}

/** Liga/desliga o job automático (o botão "rodar agora" independe disto). */
export async function setAutoApproveEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value, updated_by)
      VALUES ($1, jsonb_build_object('enabled', $2::boolean), $3)
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{enabled}', to_jsonb($2::boolean)),
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      `,
      [AUTO_APPROVE_SETTING_KEY, Boolean(enabled), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

/** Conta pendentes com CPF de 11 dígitos (o universo consultável). */
export async function countPendingWithCpf() {
  return withPgClient(async (client) => {
    const { rows } = await client.query(`
      SELECT count(*)::int AS n
      FROM public.pending_driver_registrations
      WHERE status = 'pendente'
        AND length(regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g')) = 11
    `);
    return rows[0]?.n ?? 0;
  });
}

async function persistLastRun(summary) {
  await withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value)
      VALUES ($1, jsonb_build_object('lastRun', $2::jsonb))
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{lastRun}', $2::jsonb),
        updated_at = now()
      `,
      [AUTO_APPROVE_SETTING_KEY, JSON.stringify(summary)],
    );
  });
}

/**
 * Varre até `limit` pendentes (mais antigos primeiro), consulta o Angellira do
 * motorista e — se `apply` — aprova (só status) os vigentes.
 *
 * @param {object} opts
 * @param {number} [opts.limit=25]      máximo de CPFs consultados por execução
 * @param {boolean} [opts.apply=true]   false = simulação (não grava)
 * @param {string|null} [opts.actorUserId=null]  uuid do operador (audit); null no job
 * @param {"timer"|"manual"} [opts.trigger="manual"]
 * @param {string|null} [opts.correlationId]
 * @returns {Promise<object>} resumo { skipped?, scanned, vigentes, approved, notFound, vencidos, errors, applied, trigger }
 */
export async function runAutoApproveAngelliraVigentes({
  limit = DEFAULT_BATCH,
  apply = true,
  actorUserId = null,
  trigger = "manual",
  correlationId = null,
} = {}) {
  if (running) {
    return { skipped: true, reason: "already_running" };
  }
  running = true;
  const startedAt = Date.now();
  const today = todaySaoPaulo();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || DEFAULT_BATCH));

  try {
    // 1. Pega os pendentes com CPF válido (dedupe por CPF, guardando todos os ids).
    const idsByCpf = new Map();
    await withPgClient(async (client) => {
      const { rows } = await client.query(
        `
        SELECT id, regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g') AS cpf
        FROM public.pending_driver_registrations
        WHERE status = 'pendente'
          AND length(regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g')) = 11
        ORDER BY created_at ASC
        LIMIT $1
        `,
        [safeLimit],
      );
      for (const row of rows) {
        if (!idsByCpf.has(row.cpf)) idsByCpf.set(row.cpf, []);
        idsByCpf.get(row.cpf).push(row.id);
      }
    });

    const cpfs = [...idsByCpf.keys()];
    const vigenteIds = [];
    let vigentes = 0;
    let notFound = 0;
    let vencidos = 0;
    let errors = 0;

    // 2. Consulta o Angellira de cada CPF (sequencial + pacing; respeita o
    //    circuit-breaker do cliente — se abrir, encerra a leva).
    for (const cpf of cpfs) {
      let rec = null;
      try {
        rec = await lookupAngelliraDriverByCpf(cpf, { correlationId: correlationId || "auto-approve-angellira" });
      } catch (err) {
        errors += 1;
        const msg = String(err?.message || err);
        if (msg.includes("CIRCUIT_OPEN")) {
          logStructuredEvent("warn", "auto-approve-angellira.circuit_open", { correlationId, processed: cpfs.indexOf(cpf) });
          break;
        }
        continue;
      }

      const status = rec?.status;
      const validUntil = rec?.validUntil ? String(rec.validUntil).slice(0, 10) : null;
      if (status === "FOUND" && validUntil && validUntil >= today) {
        vigentes += 1;
        vigenteIds.push(...idsByCpf.get(cpf));
      } else if (status === "FOUND") {
        vencidos += 1; // encontrado mas vencido/sem validade → não aprova
      } else if (status === "NOT_FOUND") {
        notFound += 1;
      } else {
        errors += 1; // UNAVAILABLE etc.
      }

      await sleep(PACING_MS);
    }

    // 3. Aplica (só status) nos vigentes.
    let approved = 0;
    if (apply && vigenteIds.length) {
      await withPgClient(async (client) => {
        const { rows } = await client.query(
          `
          UPDATE public.pending_driver_registrations
          SET status = 'aprovado',
              reviewed_at = now(),
              reviewed_by_id = $1,
              observacoes = $2
          WHERE status = 'pendente' AND id = ANY($3::uuid[])
          RETURNING id
          `,
          [
            AUTO_APPROVE_MARKER,
            `Aprovado automaticamente (${trigger}): motorista Conforme e vigente no Angellira em ${today}.`,
            vigenteIds,
          ],
        );
        approved = rows.length;

        // Audit best-effort — nunca deixa uma falha de auditoria quebrar a aprovação.
        try {
          await insertSecurityAuditEvent(client, {
            eventType: "operator.cadastro.auto_approved_angellira",
            actorUserId: actorUserId,
            actorRole: actorUserId ? "operator" : "system",
            resourceType: "pending_driver_registration",
            resourceId: null,
            action: "auto-approve-angellira-batch",
            outcome: "success",
            requestIp: null,
            correlationId,
            metadata: { trigger, approved, vigentes, scanned: cpfs.length, ids: rows.map((r) => r.id) },
          });
        } catch (auditErr) {
          logStructuredEvent("warn", "auto-approve-angellira.audit_failed", { correlationId, message: String(auditErr?.message || auditErr) });
        }
      });
    }

    const summary = {
      at: new Date().toISOString(),
      trigger,
      applied: Boolean(apply),
      scanned: cpfs.length,
      vigentes,
      approved,
      vencidos,
      notFound,
      errors,
      durationMs: Date.now() - startedAt,
    };

    if (apply) {
      await persistLastRun(summary);
    }
    logStructuredEvent("info", "auto-approve-angellira.run", { correlationId, ...summary });
    return summary;
  } finally {
    running = false;
  }
}
