/**
 * driver-outreach — use-cases da TELA DE CONTROLE do operador (Wave B/C).
 * Overview (status + fila + log + opt-outs), salvar settings, opt-out, disparar
 * varredura, cancelar item da fila.
 */

import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { ValidationError } from "../../domain/load-claims/errors.js";
import { normalizeText } from "../../domain/driver-outreach/detection.js";
import {
  connectWhatsappInstance,
  getWhatsappConnectionState,
  logoutWhatsappInstance,
  sendWhatsappText,
} from "../../infrastructure/whatsapp/evolution-client.js";
import { getOutreachConfig, loadOutreachSettings, updateOutreachSettings } from "./config.js";
import { scanAndEnqueueOutreach } from "./scan-and-enqueue.js";
import { composeOutreachMessage, normalizeDriverPhone } from "./messages.js";
import { getDriverOpportunities } from "./get-driver-opportunities.js";
import { checkAngelliraVigencia } from "./angellira-check.js";
import { enqueueDriverOutreach } from "./enqueue.js";
import { saveWhatsappMessage } from "./whatsapp-messages.js";

const onlyDigits = (v) => String(v || "").replace(/\D/g, "");
const SENDABLE_TRIGGERS = ["churn", "lost_registration", "abandonment", "return_load"];

function isMissingTableError(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

/**
 * Resolve nomes de motoristas a partir dos driver_keys (CPF) — motoristas_historico
 * primeiro, cadastro (pending_driver_registrations) como fallback. Batch (2 queries),
 * não por linha. Retorna { [cpf]: nome }.
 */
async function resolveDriverNames(client, driverKeys) {
  const cpfKeys = [...new Set((driverKeys || []).map(String).filter((k) => /^\d{11}$/.test(k)))];
  const nameByCpf = {};
  if (!cpfKeys.length) return nameByCpf;

  const ph = cpfKeys.map((_, i) => `$${i + 1}`).join(",");
  try {
    const { rows } = await client.query(
      `SELECT cpf, nome FROM public.motoristas_historico WHERE cpf IN (${ph}) AND nome IS NOT NULL`,
      cpfKeys,
    );
    for (const r of rows) if (r.cpf && r.nome && !nameByCpf[r.cpf]) nameByCpf[r.cpf] = r.nome;
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  const missing = cpfKeys.filter((c) => !nameByCpf[c]);
  if (missing.length) {
    const ph2 = missing.map((_, i) => `$${i + 1}`).join(",");
    try {
      const { rows } = await client.query(
        `SELECT dados->'motorista'->>'cpf' AS cpf, dados->'motorista'->>'nome' AS nome
           FROM public.pending_driver_registrations
          WHERE dados->'motorista'->>'cpf' IN (${ph2})
          ORDER BY created_at DESC`,
        missing,
      );
      for (const r of rows) if (r.cpf && r.nome && !nameByCpf[r.cpf]) nameByCpf[r.cpf] = r.nome;
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }
  return nameByCpf;
}
const clampInt = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

function isEvolutionConfigured() {
  return Boolean((process.env.EVOLUTION_API_TOKEN || "").trim());
}

/** Painel: settings efetivas + estatísticas + fila + log + opt-outs. */
export async function getOutreachOverview({ correlationId } = {}) {
  return withPgClient(async (client) => {
    const cfg = await getOutreachConfig(client);
    const settingsRow = await loadOutreachSettings(client);

    const { rows: statusRows } = await client.query(
      `SELECT status, count(*) AS n FROM public.pending_driver_outreach GROUP BY status`,
    );
    const queueStats = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of statusRows) queueStats[r.status] = Number(r.n);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { rows: s24 } = await client.query(
      `SELECT count(*) AS n FROM public.driver_outreach_log
        WHERE channel = 'evolution' AND status = 'sent' AND created_at > $1`,
      [cutoff],
    );
    const sentLast24h = Number(s24[0]?.n || 0);

    const { rows: queue } = await client.query(
      `SELECT id, driver_key, trigger, phone, message, status, retry_count, last_error, created_at, sent_at
         FROM public.pending_driver_outreach ORDER BY created_at DESC LIMIT 200`,
    );
    // Resolve o NOME do motorista (coluna Motorista exibe nome, não CPF).
    const nameByCpf = await resolveDriverNames(client, queue.map((q) => q.driver_key));
    for (const q of queue) {
      q.driver_name = /^\d{11}$/.test(String(q.driver_key)) ? nameByCpf[q.driver_key] || null : q.driver_key;
    }
    const { rows: log } = await client.query(
      `SELECT driver_key, trigger, status, created_at
         FROM public.driver_outreach_log ORDER BY created_at DESC LIMIT 25`,
    );
    const { rows: optouts } = await client.query(
      `SELECT driver_key, phone, reason, created_at
         FROM public.driver_outreach_optout ORDER BY created_at DESC LIMIT 100`,
    );

    return {
      settings: {
        enabled: cfg.enabled,
        coldEnabled: cfg.coldEnabled,
        dailyCap: cfg.dailyCap,
        quietStartHour: cfg.quietStartHour,
        quietEndHour: cfg.quietEndHour,
        routeNeedEnabled: cfg.routeNeedEnabled,
        routeNeedDaysAhead: cfg.routeNeedDaysAhead,
        routeNeedWaveSize: cfg.routeNeedWaveSize,
        updatedAt: settingsRow?.updated_at ?? null,
      },
      timing: {
        pollSeconds: cfg.pollSeconds,
        scanIntervalMin: cfg.scanIntervalMin,
        batchSize: cfg.batchSize,
        scanMaxCandidates: cfg.scanMaxCandidates,
      },
      evolutionConfigured: isEvolutionConfigured(),
      queueStats,
      sentLast24h,
      queue,
      log,
      optouts,
      meta: { correlationId: correlationId || null, generatedAt: new Date().toISOString() },
    };
  });
}

/** Salva um patch parcial nas settings (controlado pela tela). */
export async function saveOutreachSettings(patch = {}, updatedBy = null) {
  const clean = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (typeof patch.coldEnabled === "boolean") clean.cold_enabled = patch.coldEnabled;
  if (patch.dailyCap !== undefined) clean.daily_cap = clampInt(patch.dailyCap, 0, 1000, 50);
  if (patch.quietStartHour !== undefined) clean.quiet_start_hour = clampInt(patch.quietStartHour, 0, 23, 8);
  if (patch.quietEndHour !== undefined) clean.quiet_end_hour = clampInt(patch.quietEndHour, 0, 24, 20);
  if (typeof patch.routeNeedEnabled === "boolean") clean.route_need_enabled = patch.routeNeedEnabled;
  if (patch.routeNeedDaysAhead !== undefined)
    clean.route_need_days_ahead = clampInt(patch.routeNeedDaysAhead, 0, 60, 3);
  if (patch.routeNeedWaveSize !== undefined)
    clean.route_need_wave_size = clampInt(patch.routeNeedWaveSize, 1, 50, 5);
  const row = await withPgTransaction((client) => updateOutreachSettings(client, clean, updatedBy));
  return {
    enabled: Boolean(row.enabled),
    coldEnabled: Boolean(row.cold_enabled),
    dailyCap: Number(row.daily_cap),
    quietStartHour: Number(row.quiet_start_hour),
    quietEndHour: Number(row.quiet_end_hour),
    routeNeedEnabled: Boolean(row.route_need_enabled),
    routeNeedDaysAhead: Number(row.route_need_days_ahead),
    routeNeedWaveSize: Number(row.route_need_wave_size),
    updatedAt: row.updated_at ?? null,
  };
}

/** Adiciona/atualiza um opt-out (motorista pediu para não receber). */
export async function addOutreachOptout({ cpf, nome, phone, reason } = {}, createdBy = null) {
  const driverKey = onlyDigits(cpf) || normalizeText(nome);
  if (!driverKey) throw new ValidationError("Informe o CPF ou o nome do motorista.");
  await withPgClient((client) =>
    client.query(
      `INSERT INTO public.driver_outreach_optout (driver_key, phone, reason, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (driver_key) DO UPDATE SET phone = EXCLUDED.phone, reason = EXCLUDED.reason`,
      [driverKey, onlyDigits(phone) || null, reason || null, createdBy || null],
    ),
  );
  return { driverKey };
}

export async function removeOutreachOptout(driverKey) {
  const key = String(driverKey || "").trim();
  if (!key) throw new ValidationError("driverKey obrigatório.");
  await withPgClient((client) =>
    client.query(`DELETE FROM public.driver_outreach_optout WHERE driver_key = $1`, [key]),
  );
  return { ok: true };
}

/** Cancela um item pendente da fila (não envia). */
export async function cancelQueuedOutreach(id) {
  if (!id) throw new ValidationError("id obrigatório.");
  await withPgClient((client) =>
    client.query(
      `UPDATE public.pending_driver_outreach
          SET status = 'skipped', last_error = 'cancelado pelo operador'
        WHERE id = $1 AND status = 'pending'`,
      [id],
    ),
  );
  return { ok: true };
}

/** Dispara uma varredura de detecção+enfileiramento na hora. */
export async function triggerOutreachScan() {
  return scanAndEnqueueOutreach();
}

// ─── Detalhe / edição / envio de um item da fila ──────────────────────────────

/**
 * Detalhe de um item da fila para o modal do operador: a linha completa (com a
 * mensagem que será enviada) + o contexto do motorista (dados que faltam,
 * gatilhos disponíveis, telefones candidatos) reaproveitando a detecção de
 * oportunidades. Tolerante a falha na detecção (retorna só a linha).
 */
export async function getOutreachQueueItem(id) {
  if (!id) throw new ValidationError("id obrigatório.");
  const row = await withPgClient((client) =>
    client
      .query(
        `SELECT id, driver_key, trigger, phone, message, status, retry_count,
                next_attempt_at, last_error, created_at, sent_at
           FROM public.pending_driver_outreach WHERE id = $1`,
        [id],
      )
      .then((r) => r.rows[0] || null),
  );
  if (!row) throw new ValidationError("Item da fila não encontrado.");

  const isCpf = /^\d{11}$/.test(String(row.driver_key));
  let bundle = null;
  try {
    bundle = await getDriverOpportunities({
      cpf: isCpf ? row.driver_key : undefined,
      nome: isCpf ? undefined : row.driver_key,
      phone: row.phone,
    });
  } catch {
    bundle = null;
  }

  const opportunities = bundle?.opportunities ?? [];
  const detectedByTrigger = new Map(opportunities.map((o) => [o.trigger, o]));
  const driverName = bundle?.driver?.nome ?? (isCpf ? null : row.driver_key);

  // Mensagem sugerida por gatilho: usa a composição da detecção quando o gatilho
  // foi detectado (contexto real) e cai para a genérica quando não.
  const messagesByTrigger = {};
  for (const t of SENDABLE_TRIGGERS) {
    const detected = detectedByTrigger.get(t);
    messagesByTrigger[t] = detected?.message || composeOutreachMessage(t, { nome: driverName }) || "";
  }

  // Telefones candidatos ("para quem enviar"): o da fila + o resolvido na detecção.
  const phoneCandidates = [...new Set([row.phone, bundle?.driver?.phone].filter(Boolean))];

  // Guardrail: confere se o motorista já tem cadastro VIGENTE no Angellira —
  // evita cobrar "finalize seu cadastro" de quem já está cadastrado (o status
  // local não é confiável).
  const angellira = isCpf ? await checkAngelliraVigencia(row.driver_key) : { checked: false, vigente: false };

  // Nome do motorista p/ exibição (o modal mostra nome, não CPF).
  let resolvedName = bundle?.driver?.nome ?? (isCpf ? null : row.driver_key);
  if (isCpf) {
    const nameMap = await withPgClient((c) => resolveDriverNames(c, [row.driver_key]));
    resolvedName = nameMap[row.driver_key] || resolvedName;
  }

  return {
    item: {
      id: row.id,
      driverKey: row.driver_key,
      trigger: row.trigger,
      phone: row.phone,
      message: row.message,
      status: row.status,
      retryCount: row.retry_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    },
    driver: {
      cpf: bundle?.driver?.cpf ?? (isCpf ? row.driver_key : null),
      nome: resolvedName,
      phone: bundle?.driver?.phone ?? row.phone,
    },
    optedOut: bundle?.optedOut ?? false,
    opportunities,
    messagesByTrigger,
    phoneCandidates,
    angellira,
  };
}

/**
 * Edita um item PENDENTE da fila: motivo/gatilho, telefone (destinatário) e/ou
 * a mensagem. Só itens `pending` (não mexe em enviados). (driver_key, trigger)
 * é único — trocar o gatilho para um já enfileirado devolve erro amigável.
 */
export async function updateOutreachQueueItem(id, patch = {}) {
  if (!id) throw new ValidationError("id obrigatório.");
  const sets = [];
  const vals = [];
  let i = 1;
  if (patch.trigger !== undefined) {
    const t = String(patch.trigger);
    if (!SENDABLE_TRIGGERS.includes(t)) throw new ValidationError("Gatilho inválido.");
    sets.push(`trigger = $${i++}`);
    vals.push(t);
  }
  if (patch.phone !== undefined) {
    const p = normalizeDriverPhone(patch.phone);
    if (!p) throw new ValidationError("Telefone inválido (informe com DDD).");
    sets.push(`phone = $${i++}`);
    vals.push(p);
  }
  if (patch.message !== undefined) {
    const m = String(patch.message).trim();
    if (!m) throw new ValidationError("A mensagem não pode ficar vazia.");
    sets.push(`message = $${i++}`);
    vals.push(m.slice(0, 2000));
  }
  if (!sets.length) throw new ValidationError("Nada para atualizar.");
  vals.push(id);
  let rows;
  try {
    ({ rows } = await withPgClient((client) =>
      client.query(
        `UPDATE public.pending_driver_outreach
            SET ${sets.join(", ")}
          WHERE id = $${i} AND status = 'pending'
          RETURNING id, driver_key, trigger, phone, message, status`,
        vals,
      ),
    ));
  } catch (err) {
    if (err?.code === "23505") {
      throw new ValidationError("Já existe um envio pendente para este motorista com esse gatilho.");
    }
    throw err;
  }
  if (!rows[0]) throw new ValidationError("Só é possível editar itens que ainda estão pendentes.");
  return { ok: true, item: rows[0] };
}

/**
 * Envia AGORA um item da fila via Evolution (ação explícita do operador —
 * ignora cap/quiet-hours, mas respeita opt-out). Atualiza a linha e registra no
 * log. Em falha, marca `failed` e propaga o erro.
 */
export async function sendOutreachQueueItemNow(id) {
  if (!id) throw new ValidationError("id obrigatório.");
  if (!isEvolutionConfigured()) throw new ValidationError("Gateway WhatsApp não configurado.");
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, driver_key, trigger, phone, message, status
         FROM public.pending_driver_outreach WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ValidationError("Item não encontrado.");
    if (row.status === "sent") throw new ValidationError("Este item já foi enviado.");

    const { rows: oo } = await client.query(
      `SELECT 1 FROM public.driver_outreach_optout WHERE driver_key = $1 LIMIT 1`,
      [row.driver_key],
    );
    if (oo.length) throw new ValidationError("Motorista está na lista de opt-out (não perturbe).");

    try {
      await sendWhatsappText({ to: row.phone, text: row.message, correlationId: `outreach-manual-${id}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await client.query(
        `UPDATE public.pending_driver_outreach
            SET status='failed', last_error=$2, retry_count=retry_count+1 WHERE id=$1`,
        [id, msg.slice(0, 300)],
      );
      await client
        .query(
          `INSERT INTO public.driver_outreach_log (driver_key, trigger, channel, status, phone, payload)
           VALUES ($1, $2, 'evolution', 'failed', $3, $4::jsonb)`,
          [row.driver_key, row.trigger, row.phone, JSON.stringify({ error: msg.slice(0, 200) })],
        )
        .catch(() => {});
      throw new ValidationError(`Falha ao enviar: ${msg}`);
    }

    await client.query(
      `UPDATE public.pending_driver_outreach
          SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`,
      [id],
    );
    await client
      .query(
        `INSERT INTO public.driver_outreach_log (driver_key, trigger, channel, status, phone, payload)
         VALUES ($1, $2, 'evolution', 'sent', $3, '{}'::jsonb)`,
        [row.driver_key, row.trigger, row.phone],
      )
      .catch(() => {});
    return { ok: true, id, to: `**${String(row.phone).slice(-2)}` };
  });
}

/**
 * Revalida a fila contra o Angellira: cancela (skip) os itens de
 * `lost_registration` cujo motorista já tem cadastro VIGENTE — eram falsos
 * positivos (o status local não é confiável). Concorrência limitada p/ não
 * martelar a API (cada consulta ~3-5s; cache de 60s no client).
 */
export async function revalidateOutreachQueueAgainstAngellira() {
  const rows = await withPgClient((client) =>
    client
      .query(
        `SELECT id, driver_key, trigger FROM public.pending_driver_outreach WHERE status = 'pending'`,
      )
      .then((r) => r.rows),
  );

  const result = { checked: 0, cancelled: 0, kept: 0, skippedNoCpf: 0 };
  const CONCURRENCY = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (!/^\d{11}$/.test(String(row.driver_key))) {
        result.skippedNoCpf += 1;
        continue;
      }
      // Só faz sentido para o gatilho de cadastro.
      if (row.trigger !== "lost_registration") {
        result.kept += 1;
        continue;
      }
      const v = await checkAngelliraVigencia(row.driver_key);
      result.checked += 1;
      if (v.vigente) {
        await withPgClient((client) =>
          client.query(
            `UPDATE public.pending_driver_outreach
                SET status = 'skipped', last_error = $2
              WHERE id = $1 AND status = 'pending'`,
            [row.id, `já cadastrado no Angellira (vigente até ${v.validUntil})`],
          ),
        );
        result.cancelled += 1;
      } else {
        result.kept += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return result;
}

/**
 * Insere manualmente um item na fila (operador). Compõe a mensagem a partir do
 * gatilho quando não informada. Idempotente por (driver_key, trigger).
 */
export async function createManualOutreach({ cpf, nome, phone, trigger, message } = {}) {
  const t = String(trigger || "");
  if (!SENDABLE_TRIGGERS.includes(t)) throw new ValidationError("Selecione um gatilho válido.");
  const normalizedPhone = normalizeDriverPhone(phone);
  if (!normalizedPhone) throw new ValidationError("Telefone inválido (informe com DDD).");
  const driverKey = onlyDigits(cpf) || normalizeText(nome);
  if (!driverKey) throw new ValidationError("Informe o CPF ou o nome do motorista.");
  const composed = String(message || "").trim() || composeOutreachMessage(t, { nome }) || "";
  if (!composed) throw new ValidationError("Não foi possível compor a mensagem — escreva o texto.");

  const id = await withPgClient((client) =>
    enqueueDriverOutreach(client, {
      driverKey,
      trigger: t,
      phone: normalizedPhone,
      message: composed.slice(0, 2000),
      correlationId: "manual",
    }),
  );
  if (!id) throw new ValidationError("Já existe um envio pendente para este motorista com esse gatilho.");
  return { ok: true, id };
}

/**
 * Concilia cadastros com o Angellira: cadastros em 'pendente'/'draft'/'rascunho'
 * cujo motorista JÁ tem cadastro VIGENTE no Angellira são marcados como
 * 'concluido' (somem de "cadastro não finalizado" em todo o sistema).
 */
export async function reconcileRegistrationsWithAngellira() {
  const rows = await withPgClient((client) =>
    client
      .query(
        `SELECT id, dados->'motorista'->>'cpf' AS cpf, status
           FROM public.pending_driver_registrations
          WHERE status IN ('pendente', 'draft', 'rascunho')`,
      )
      .then((r) => r.rows)
      .catch((err) => {
        if (isMissingTableError(err)) return [];
        throw err;
      }),
  );

  // Mapa CPF normalizado → ids das linhas (casa por id no UPDATE, robusto a
  // formatação e pg-mem-safe: sem regexp_replace na query).
  const idsByCpf = new Map();
  for (const r of rows) {
    const cpf = onlyDigits(r.cpf);
    if (!/^\d{11}$/.test(cpf)) continue;
    if (!idsByCpf.has(cpf)) idsByCpf.set(cpf, []);
    idsByCpf.get(cpf).push(r.id);
  }
  const cpfs = [...idsByCpf.keys()];
  const result = { candidates: rows.length, cpfsChecked: 0, vigentes: 0, updated: 0, unavailable: 0 };
  if (!cpfs.length) return result;

  const vigenteCpfs = [];
  // Concorrência maior — o Angellira leva 10-25s por CPF; com 8 em paralelo a
  // varredura de algumas dezenas de CPFs cabe em ~1-2 min (roda em background).
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < cpfs.length) {
      const cpf = cpfs[cursor++];
      const v = await checkAngelliraVigencia(cpf);
      result.cpfsChecked += 1;
      if (v.vigente) vigenteCpfs.push(cpf);
      // status UNAVAILABLE = Angellira fora do ar / timeout — reporta p/ o operador
      // saber que não deu p/ conferir aquele CPF (não é "não vigente").
      else if (v.status === "UNAVAILABLE" || v.checked === false) result.unavailable += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cpfs.length) }, worker));
  result.vigentes = vigenteCpfs.length;

  const vigenteIds = vigenteCpfs.flatMap((c) => idsByCpf.get(c) || []);
  if (vigenteIds.length) {
    const ph = vigenteIds.map((_, i) => `$${i + 1}`).join(",");
    const { rowCount } = await withPgClient((client) =>
      client.query(
        `UPDATE public.pending_driver_registrations
            SET status = 'concluido'
          WHERE status IN ('pendente', 'draft', 'rascunho')
            AND id IN (${ph})`,
        vigenteIds,
      ),
    );
    result.updated = rowCount ?? 0;
  }
  return result;
}

// Evita conciliações concorrentes (o operador clicando várias vezes).
let reconcileInFlight = false;

/**
 * Inicia a conciliação em SEGUNDO PLANO e retorna imediatamente. Motivo: o
 * Angellira leva 10-25s por CPF; conciliar dezenas de CPFs sincronamente
 * estoura o proxy (nginx proxy_read_timeout 60s) → o operador via "não
 * funciona". Aqui devolvemos na hora e, ao terminar, gravamos uma notificação
 * (`reconcile_done`) que aparece no sino do operador.
 */
export async function startReconcileRegistrationsInBackground() {
  if (reconcileInFlight) {
    return { started: false, alreadyRunning: true };
  }
  // Conta candidatos rápido p/ dar feedback imediato ao operador.
  const candidates = await withPgClient((client) =>
    client
      .query(
        `SELECT count(*)::int AS n FROM public.pending_driver_registrations
          WHERE status IN ('pendente', 'draft', 'rascunho')`,
      )
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => 0),
  );

  if (!candidates) return { started: false, candidates: 0, alreadyRunning: false };

  reconcileInFlight = true;
  // Fire-and-forget: NÃO damos await. O handler HTTP retorna logo.
  (async () => {
    try {
      const result = await reconcileRegistrationsWithAngellira();
      await withPgClient((client) =>
        client
          .query(
            `INSERT INTO public.operator_notifications (kind, title, body, metadata)
             VALUES ('reconcile_done', $1, $2, $3::jsonb)`,
            [
              `Conciliação concluída: ${result.updated} cadastro(s) marcados como concluído`,
              `${result.vigentes} vigente(s) no Angellira de ${result.cpfsChecked} verificados` +
                (result.unavailable ? ` · ${result.unavailable} sem resposta do Angellira` : ""),
              JSON.stringify(result),
            ],
          )
          .catch(() => {}),
      );
      logStructuredEvent("info", "driver-outreach.reconcile.done", result);
    } catch (err) {
      await withPgClient((client) =>
        client
          .query(
            `INSERT INTO public.operator_notifications (kind, title, body, metadata)
             VALUES ('reconcile_done', $1, $2, $3::jsonb)`,
            [
              "Conciliação falhou",
              err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
              JSON.stringify({ error: true }),
            ],
          )
          .catch(() => {}),
      );
      console.error("[reconcile] erro em background:", err?.message);
    } finally {
      reconcileInFlight = false;
    }
  })();

  return { started: true, candidates, alreadyRunning: false };
}

// ─── Conexão do WhatsApp (Evolution) ──────────────────────────────────────────

/** Status da conexão do número WhatsApp. */
export async function getWhatsappStatus() {
  if (!isEvolutionConfigured()) return { configured: false, state: "not_configured", instance: null };
  try {
    const s = await getWhatsappConnectionState();
    return { configured: true, ...s };
  } catch (err) {
    return { configured: true, state: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Inicia o pareamento. Sem `number` → modo QR (base64 p/ escanear). Com `number`
 * → modo código (pairingCode de 8 caracteres p/ digitar no WhatsApp, sem câmera).
 */
export async function connectWhatsapp({ number } = {}) {
  if (!isEvolutionConfigured()) {
    throw new ValidationError("Gateway WhatsApp não configurado (EVOLUTION_API_TOKEN ausente).");
  }
  return connectWhatsappInstance({ number });
}

/** Desconecta o número atual (logout da instância). */
export async function disconnectWhatsapp() {
  if (!isEvolutionConfigured()) throw new ValidationError("Gateway WhatsApp não configurado.");
  return logoutWhatsappInstance();
}

/** Envia uma mensagem de teste para validar a conexão. */
export async function sendWhatsappTestMessage({ phone, text } = {}) {
  if (!isEvolutionConfigured()) throw new ValidationError("Gateway WhatsApp não configurado.");
  const to = onlyDigits(phone);
  if (to.length < 10) throw new ValidationError("Informe um telefone válido (com DDD).");
  const body = (text || "").trim() || "✅ Teste de conexão — Lamônica Cargas. Se você recebeu isto, o envio está funcionando.";
  await sendWhatsappText({ to, text: body, correlationId: "outreach-test" });
  return { ok: true, to: `**${to.slice(-2)}` };
}

// ─── Notificações do operador (sino do menu) ──────────────────────────────────

export async function listOperatorNotifications({ limit = 40 } = {}) {
  return withPgClient(async (client) => {
    try {
      const { rows: unseen } = await client.query(
        `SELECT count(*) AS n FROM public.operator_notifications WHERE seen = false`,
      );
      const { rows } = await client.query(
        `SELECT id, kind, title, body, metadata, seen, seen_at, created_at
           FROM public.operator_notifications
          ORDER BY created_at DESC
          LIMIT $1`,
        [Math.max(1, Math.min(200, Number(limit) || 40))],
      );
      return { unseenCount: Number(unseen[0]?.n ?? 0), items: rows };
    } catch (err) {
      // Tabela pode não existir ainda (migration não aplicada).
      if (err?.code === "42P01") return { unseenCount: 0, items: [] };
      throw err;
    }
  });
}

export async function markNotificationsSeen(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return { updated: 0 };
  const ph = list.map((_, i) => `$${i + 1}`).join(",");
  const { rowCount } = await withPgClient((client) =>
    client
      .query(
        `UPDATE public.operator_notifications
            SET seen = true, seen_at = now()
          WHERE id IN (${ph})`,
        list,
      )
      .catch((err) => {
        if (err?.code === "42P01") return { rowCount: 0 };
        throw err;
      }),
  );
  return { updated: rowCount ?? 0 };
}

export async function deleteOperatorNotifications({ ids, all } = {}) {
  if (all) {
    const { rowCount } = await withPgClient((client) =>
      client
        .query(`DELETE FROM public.operator_notifications`)
        .catch((err) => (err?.code === "42P01" ? { rowCount: 0 } : Promise.reject(err))),
    );
    return { deleted: rowCount ?? 0 };
  }
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!list.length) return { deleted: 0 };
  const ph = list.map((_, i) => `$${i + 1}`).join(",");
  const { rowCount } = await withPgClient((client) =>
    client
      .query(`DELETE FROM public.operator_notifications WHERE id IN (${ph})`, list)
      .catch((err) => (err?.code === "42P01" ? { rowCount: 0 } : Promise.reject(err))),
  );
  return { deleted: rowCount ?? 0 };
}

export async function markAllNotificationsSeen() {
  const { rowCount } = await withPgClient((client) =>
    client
      .query(
        `UPDATE public.operator_notifications
            SET seen = true, seen_at = now()
          WHERE seen = false`,
      )
      .catch((err) => {
        if (err?.code === "42P01") return { rowCount: 0 };
        throw err;
      }),
  );
  return { updated: rowCount ?? 0 };
}

// ─── Chat WhatsApp (lista de conversas + histórico + envio manual) ────────────

/**
 * Lista de conversas (uma por telefone) com última mensagem e count de não lidas.
 *
 * Sem busca → só conversas existentes (WhatsApp-like), mais recente primeiro.
 * Com busca → une (conversas casando) + (motoristas cadastrados casando por
 * nome/CPF/telefone) — permite iniciar chat com qualquer motorista do sistema
 * mesmo sem histórico prévio.
 */
export async function listWhatsappConversations({ limit = 60, search } = {}) {
  const searchTerm = String(search || "").trim();
  const searchDigits = searchTerm.replace(/\D/g, "");
  const cap = Math.max(1, Math.min(200, Number(limit) || 60));

  return withPgClient(async (client) => {
    try {
      // 1) Conversas existentes (base).
      const convParams = [];
      let convFilter = "";
      if (searchTerm) {
        convParams.push(`%${searchTerm}%`);
        convFilter = ` WHERE (phone ILIKE $${convParams.length} OR driver_key ILIKE $${convParams.length})`;
      }
      convParams.push(cap);
      const convLimitIdx = convParams.length;
      const { rows: convRows } = await client.query(
        `WITH last_msgs AS (
           SELECT DISTINCT ON (phone)
                  phone, driver_key, text, direction, timestamp, message_type
             FROM public.whatsapp_messages
             ${convFilter}
            ORDER BY phone, timestamp DESC
         ),
         unread AS (
           SELECT phone, count(*) AS n
             FROM public.whatsapp_messages
            WHERE direction = 'in' AND status <> 'read'
            GROUP BY phone
         )
         SELECT lm.phone, lm.driver_key, lm.text AS last_text,
                lm.direction AS last_direction, lm.timestamp AS last_ts,
                lm.message_type AS last_type,
                COALESCE(u.n, 0) AS unread_count,
                mh.nome AS driver_name
           FROM last_msgs lm
      LEFT JOIN unread u ON u.phone = lm.phone
      LEFT JOIN public.motoristas_historico mh ON mh.cpf = lm.driver_key
          ORDER BY lm.timestamp DESC
          LIMIT $${convLimitIdx}`,
        convParams,
      );

      const items = [...convRows];

      // 2) Diretório de motoristas: se houver busca, incluir os que casam por
      //    nome/CPF/telefone e AINDA não têm conversa (dedup por phone).
      if (searchTerm) {
        const existingPhones = new Set(items.map((r) => r.phone));
        const dirParams = [`%${searchTerm}%`];
        // Casa: nome (case-insensitive), OU cpf que começa/contém dígitos,
        // OU telefone que contém os dígitos.
        let phoneClauses = "mh.nome ILIKE $1";
        if (searchDigits.length >= 2) {
          dirParams.push(`%${searchDigits}%`);
          phoneClauses += ` OR mh.cpf ILIKE $${dirParams.length} OR mh.telefone ILIKE $${dirParams.length}`;
        }
        dirParams.push(cap);
        const dirLimitIdx = dirParams.length;
        const { rows: dirRows } = await client
          .query(
            `SELECT mh.cpf AS driver_key, mh.nome AS driver_name, mh.telefone AS telefone_raw
               FROM public.motoristas_historico mh
              WHERE mh.telefone IS NOT NULL AND mh.telefone <> ''
                AND (${phoneClauses})
              ORDER BY mh.nome ASC
              LIMIT $${dirLimitIdx}`,
            dirParams,
          )
          .catch(() => ({ rows: [] }));

        for (const r of dirRows) {
          // Normaliza telefone p/ o mesmo formato usado no chat (DDI 55 + dígitos).
          const digits = String(r.telefone_raw || "").replace(/\D/g, "");
          if (digits.length < 10) continue;
          const phone = digits.startsWith("55") ? digits : `55${digits}`;
          if (existingPhones.has(phone)) continue;
          existingPhones.add(phone);
          items.push({
            phone,
            driver_key: r.driver_key,
            driver_name: r.driver_name,
            last_text: "",
            last_direction: null,
            last_ts: null,
            last_type: null,
            unread_count: 0,
          });
        }
      }

      return { items: items.slice(0, cap) };
    } catch (err) {
      if (err?.code === "42P01") return { items: [] };
      throw err;
    }
  });
}

export async function listWhatsappMessages({ phone, limit = 200 } = {}) {
  const p = onlyDigits(phone);
  if (!p) throw new ValidationError("Telefone obrigatório.");
  return withPgClient(async (client) => {
    try {
      const { rows } = await client.query(
        `SELECT id, direction, external_id, phone, driver_key, text, message_type, status, timestamp
           FROM public.whatsapp_messages
          WHERE phone = $1
          ORDER BY timestamp ASC
          LIMIT $2`,
        [p, Math.max(1, Math.min(1000, Number(limit) || 200))],
      );
      // Marca as IN como lidas.
      await client
        .query(
          `UPDATE public.whatsapp_messages
              SET status = 'read'
            WHERE phone = $1 AND direction = 'in' AND status <> 'read'`,
          [p],
        )
        .catch(() => {});
      return { items: rows };
    } catch (err) {
      if (err?.code === "42P01") return { items: [] };
      throw err;
    }
  });
}

/** Envia uma mensagem manual no chat (operador digitou) via Evolution. */
export async function sendManualChatMessage({ phone, text } = {}) {
  if (!isEvolutionConfigured()) throw new ValidationError("Gateway WhatsApp não configurado.");
  const to = onlyDigits(phone);
  if (to.length < 10) throw new ValidationError("Telefone inválido (com DDD).");
  const body = String(text || "").trim();
  if (!body) throw new ValidationError("A mensagem não pode ficar vazia.");
  // sendWhatsappText já registra a OUT no chat (via evolution-client).
  await sendWhatsappText({ to, text: body, correlationId: "operator-manual-chat" });
  return { ok: true };
}
