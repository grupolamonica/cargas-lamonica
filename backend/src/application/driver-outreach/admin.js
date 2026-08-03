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
import { performAngelliraPrecheck } from "../operator-admin/use-cases/angellira/precheck.js";
import { isStatusTextConforme } from "../operator-admin/use-cases/angellira/conformidade.js";
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

// ── Cache + single-flight do overview da tela de Mensagens ───────────────────
// O payload é GLOBAL, não por operador. Evidência: o handler
// (interface/http/driver-outreach/handlers.js) chama getOutreachOverview com SÓ
// `{ correlationId }` — nenhuma identidade de usuário entra na função — e
// nenhuma das tabelas lidas tem coluna de escopo por operador: fila
// (pending_driver_outreach, migration 20260707130000), log e opt-outs
// (20260707120000) só têm `created_by` de AUDITORIA, que nunca aparece num
// WHERE, e driver_outreach_settings é linha singleton (id = 1). Logo UMA entrada
// de módulo serve todos os operadores — não há identidade a chavear (se
// houvesse, o payload de um operador vazaria para o outro).
// Custo por chamada: 7 a 9 queries — settings ×2 (getOutreachConfig +
// loadOutreachSettings), GROUP BY de status, count do log de 24h, fila
// (LIMIT 200), até 2 de resolução de nome, log (LIMIT 25) e opt-outs
// (LIMIT 100). A tela faz poll (refetchInterval em frontend/src/pages/Outreach.tsx),
// por operador e por aba, sem dedupe nenhum → N abas = N × 9 queries por ciclo.
//
// ⚠ TTL 45s > poll de 30s (margem de 1,5×). NÃO REDUZIR ABAIXO DO POLL.
// O par antigo era TTL 10s × poll 15s: o TTL expirava ANTES do poll seguinte, ou
// seja o cache não servia nada (mesmo defeito medido no sino em produção — 35
// execuções em 1091s, uma por poll, zero hit). Aqui foram mexidos os DOIS lados:
// o poll da tela caiu de 15s para 30s (é um painel administrativo de fila; o
// worker de envio trabalha em drip com MINUTOS entre mensagens, então 15s nunca
// mostrou nada que 30s não mostre) e o TTL subiu para 45s. Resultado: uma
// execução de 8-9 queries a cada 60s no lugar de uma a cada 15s.
// Toda mutação da tela busta a entrada (read-your-write), então a ação do
// operador continua aparecendo na hora, independente do TTL. 0 em teste.
// A chave inclui os TRÊS LIMITs efetivos. Hoje são constantes (o handler não
// aceita limite na query string — o único parâmetro é o correlationId), mas
// entregar 200 itens a quem pediu 25 é exatamente o bug que a chave previne se
// algum dia virarem parâmetro.
// Ficam FORA do corpo cacheado os dois campos que não custam query e não podem
// envelhecer: `evolutionConfigured` (leitura de env) e `meta.correlationId` (é
// do REQUEST — devolver o correlationId de outro operador quebraria o rastro).
// `meta.generatedAt` continua sendo o instante em que os dados foram lidos, e
// não o do request: é o que informa a idade real do payload.
const OUTREACH_OVERVIEW_LIMITS = { queue: 200, log: 25, optouts: 100 };

const OUTREACH_OVERVIEW_POLL_MS = 30_000; // frontend/src/pages/Outreach.tsx
const OUTREACH_OVERVIEW_TTL_MS = 45_000;
/** Exportado só para o teste amarrar TTL > poll. */
export const __outreachOverviewCacheTiming = Object.freeze({
  pollMs: OUTREACH_OVERVIEW_POLL_MS,
  ttlMs: OUTREACH_OVERVIEW_TTL_MS,
});

let _overviewInFlight = null;
let _overviewCache = { at: 0, key: "", body: null };
// Epoch das mutações da tela (settings, opt-out, fila): uma leitura que COMEÇOU
// antes do write não pode repovoar o cache com o estado pré-mutação, senão a
// ação do operador só apareceria no fim do TTL.
let _overviewEpoch = 0;

function getOutreachOverviewCacheTtlMs() {
  const raw = Number.parseInt(process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return OUTREACH_OVERVIEW_TTL_MS; // default produção (> poll de 30s)
}

function outreachOverviewCacheKey(limits) {
  return `q${limits.queue}|l${limits.log}|o${limits.optouts}`;
}

/** Invalida o overview (as mutações abaixo leem o próprio write). Nunca lança. */
function bustOutreachOverviewCache() {
  _overviewEpoch += 1;
  _overviewCache = { at: 0, key: "", body: null };
}

/** Hook de teste: zera o estado de módulo do cache do overview. */
export function __resetOutreachOverviewCache() {
  _overviewInFlight = null;
  _overviewCache = { at: 0, key: "", body: null };
  _overviewEpoch = 0;
}

/** Painel: settings efetivas + estatísticas + fila + log + opt-outs. */
export async function getOutreachOverview({ correlationId } = {}) {
  const limits = OUTREACH_OVERVIEW_LIMITS;
  const key = outreachOverviewCacheKey(limits);
  const ttl = getOutreachOverviewCacheTtlMs();
  // Reafirma os campos por-request SEM mudar a ordem das chaves (spread sobre
  // chave existente preserva a posição original).
  const withRequestFields = (body, cached) => ({
    ...body,
    evolutionConfigured: isEvolutionConfigured(),
    meta: {
      correlationId: correlationId || null,
      generatedAt: body.meta.generatedAt,
      ...(cached ? { cached: true } : {}),
    },
  });

  if (ttl <= 0) return withRequestFields(await loadOutreachOverviewBody(limits), false);

  const now = Date.now();
  if (_overviewCache.body && _overviewCache.key === key && now - _overviewCache.at < ttl) {
    return withRequestFields(_overviewCache.body, true);
  }
  if (_overviewInFlight && _overviewInFlight.key === key) {
    return withRequestFields(await _overviewInFlight.promise, true);
  }

  const epoch = _overviewEpoch;
  const promise = (async () => {
    // Só cacheia sucesso: qualquer erro (schema ausente na fila/log/opt-outs não
    // é engolido) rejeita aqui e nada gruda no cache.
    const body = await loadOutreachOverviewBody(limits);
    if (_overviewEpoch === epoch) _overviewCache = { at: Date.now(), key, body };
    return body;
  })();
  _overviewInFlight = { key, promise };

  try {
    return withRequestFields(await promise, false);
  } finally {
    if (_overviewInFlight?.promise === promise) _overviewInFlight = null;
  }
}

/** Leitura crua do overview (o corpo cacheável, sem os campos por-request). */
async function loadOutreachOverviewBody(limits) {
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
         FROM public.pending_driver_outreach ORDER BY created_at DESC LIMIT $1`,
      [limits.queue],
    );
    // Resolve o NOME do motorista (coluna Motorista exibe nome, não CPF).
    const nameByCpf = await resolveDriverNames(client, queue.map((q) => q.driver_key));
    for (const q of queue) {
      q.driver_name = /^\d{11}$/.test(String(q.driver_key)) ? nameByCpf[q.driver_key] || null : q.driver_key;
    }
    const { rows: log } = await client.query(
      `SELECT driver_key, trigger, status, created_at
         FROM public.driver_outreach_log ORDER BY created_at DESC LIMIT $1`,
      [limits.log],
    );
    const { rows: optouts } = await client.query(
      `SELECT driver_key, phone, reason, created_at
         FROM public.driver_outreach_optout ORDER BY created_at DESC LIMIT $1`,
      [limits.optouts],
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
      // correlationId é reafirmado por chamada no wrapper (nunca vem do cache).
      meta: { generatedAt: new Date().toISOString() },
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
  bustOutreachOverviewCache(); // o operador tem que ver o toggle novo no refetch
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
  bustOutreachOverviewCache();
  return { driverKey };
}

export async function removeOutreachOptout(driverKey) {
  const key = String(driverKey || "").trim();
  if (!key) throw new ValidationError("driverKey obrigatório.");
  await withPgClient((client) =>
    client.query(`DELETE FROM public.driver_outreach_optout WHERE driver_key = $1`, [key]),
  );
  bustOutreachOverviewCache();
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
  bustOutreachOverviewCache();
  return { ok: true };
}

/** Dispara uma varredura de detecção+enfileiramento na hora. */
export async function triggerOutreachScan() {
  try {
    return await scanAndEnqueueOutreach();
  } finally {
    // A varredura enfileira/pula itens — a fila da tela muda.
    bustOutreachOverviewCache();
  }
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
  // CPF informado/corrigido pelo operador (ex.: não veio do documento; o motorista
  // passou por fora): a identidade da linha passa a ser o CPF (driver_key). Isso
  // corrige opt-out/dedupe, resolução de nome, Angellira e log — antes de disparar.
  let cpfDigits = null;
  if (patch.cpf !== undefined && patch.cpf !== null && String(patch.cpf).trim() !== "") {
    cpfDigits = onlyDigits(patch.cpf);
    if (cpfDigits.length !== 11) throw new ValidationError("CPF inválido (informe os 11 dígitos).");
    sets.push(`driver_key = $${i++}`);
    vals.push(cpfDigits);
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
  bustOutreachOverviewCache();

  // Best-effort: registra o CPF↔nome↔telefone em motoristas_historico (casa
  // canônica que resolveDriverNames/opportunities leem depois). Nunca falha o
  // update — o essencial (driver_key) já foi persistido acima.
  const nome = patch.nome !== undefined && patch.nome !== null ? String(patch.nome).trim() : "";
  if (cpfDigits && nome) {
    try {
      await withPgClient((client) =>
        client.query(
          `INSERT INTO public.motoristas_historico (cpf, nome, telefone)
           VALUES ($1, $2, $3)
           ON CONFLICT (cpf) DO UPDATE
             SET nome = EXCLUDED.nome,
                 telefone = COALESCE(EXCLUDED.telefone, public.motoristas_historico.telefone),
                 updated_at = now()`,
          [cpfDigits, nome, rows[0].phone || null],
        ),
      );
    } catch (err) {
      console.warn("[driver-outreach.update.motorista_historico]", err instanceof Error ? err.message : String(err));
    }
  }
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
  try {
    return await sendOutreachQueueItemNowUncached(id);
  } finally {
    // Sucesso (status='sent' + log) E falha (status='failed', retry_count+1 +
    // log) mudam a fila e as estatísticas — o operador vê na hora.
    bustOutreachOverviewCache();
  }
}

async function sendOutreachQueueItemNowUncached(id) {
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
  if (result.cancelled) bustOutreachOverviewCache(); // itens saíram de 'pending'
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
  bustOutreachOverviewCache();
  return { ok: true, id };
}

/**
 * Concilia cadastros pendentes com o Angellira exigindo os TRÊS
 * (motorista + cavalo + carreta), via performAngelliraPrecheck, olhando o
 * RÓTULO REAL do portal (`statusText` = status.description):
 *  - todos FOUND E "Conforme" → 'concluido';
 *  - ALGUM NOT_FOUND (não cadastrado) → grava o marcador `dados.nao_conformidade`
 *    (aparece na aba "Não conformidade"; o status segue 'pendente' — não sai da
 *    fila) — é a migração AUTOMÁTICA dos não-conforme;
 *  - algum FOUND mas ainda em HOMOLOGAÇÃO (rótulo != "Conforme") → pula (segue
 *    'pendente'/em processo, SEM marcar não conformidade) até virar Conforme;
 *  - algum INDISPONÍVEL (Angellira fora do ar) → pula (reavalia depois).
 */
export async function reconcileRegistrationsWithAngellira() {
  const rows = await withPgClient((client) =>
    client
      .query(
        `SELECT id, dados, status
           FROM public.pending_driver_registrations
          WHERE status IN ('pendente', 'draft', 'rascunho')`,
      )
      .then((r) => r.rows)
      .catch((err) => {
        if (isMissingTableError(err)) return [];
        throw err;
      }),
  );

  const result = { candidates: rows.length, checked: 0, concluidos: 0, naoConformes: 0, unavailable: 0, updated: 0 };
  if (!rows.length) return result;

  const toConcluir = []; // ids (os 3 conformes)
  const toMarcar = []; // { id, dados, motivos } — algum não conforme (só status='pendente')

  // O Angellira leva ~10-25s por consulta e o precheck faz 3 em paralelo por
  // cadastro; limitamos a 4 cadastros simultâneos (~12 consultas) p/ não
  // martelar a API. Roda em background.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const cpf = onlyDigits(row?.dados?.motorista?.cpf);
      if (!/^\d{11}$/.test(cpf)) continue; // sem CPF do motorista não dá p/ decidir
      let pre;
      try {
        pre = await performAngelliraPrecheck({ cadastro: row });
      } catch {
        result.unavailable += 1;
        continue;
      }
      result.checked += 1;
      const entities = [
        { key: "motorista", r: pre.motorista },
        ...(pre.cavalo ? [{ key: "cavalo", r: pre.cavalo }] : []),
        ...(pre.carreta ? [{ key: "carreta", r: pre.carreta }] : []),
      ];
      // Angellira fora do ar p/ algum → não decide agora (segue em homologação).
      if (entities.some((e) => e.r?.status === "UNAVAILABLE")) {
        result.unavailable += 1;
        continue;
      }
      // Classifica cada componente com o RÓTULO REAL do portal (statusText):
      //  - NOT_FOUND                         → não conforme (não cadastrado);
      //  - FOUND mas rótulo != "Conforme"    → ainda em HOMOLOGAÇÃO (em processo);
      //  - FOUND + "Conforme"                → conforme.
      // Só conclui quando os TRÊS estão Conforme. Em homologação NÃO é "não
      // conformidade" — segue pendente (em processo), sem marcador, até virar
      // Conforme. Antes, bastava FOUND (ignorava o rótulo) e concluía cedo demais.
      const naoConf = entities.filter((e) => e.r?.status === "NOT_FOUND");
      const emHomologacao = entities.filter(
        (e) => e.r?.status === "FOUND" && !isStatusTextConforme(e.r?.statusText),
      );
      if (naoConf.length === 0 && emHomologacao.length === 0) {
        toConcluir.push(row.id); // os 3 Conformes
      } else if (
        naoConf.length > 0 &&
        row.status === "pendente" &&
        !(row.dados && typeof row.dados === "object" && row.dados.nao_conformidade)
      ) {
        toMarcar.push({ id: row.id, dados: row.dados, motivos: naoConf.map((e) => `${e.key} não conforme no Angellira`) });
      }
      // else: só em homologação (nenhum NOT_FOUND) → não faz nada; segue pendente.
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // Conclui os que fecharam os 3 (só quando ainda pendente/draft/rascunho).
  if (toConcluir.length) {
    const ph = toConcluir.map((_, i) => `$${i + 1}`).join(",");
    const { rowCount } = await withPgClient((client) =>
      client.query(
        `UPDATE public.pending_driver_registrations
            SET status = 'concluido'
          WHERE status IN ('pendente', 'draft', 'rascunho')
            AND id IN (${ph})`,
        toConcluir,
      ),
    );
    result.concluidos = rowCount ?? 0;
    result.updated += rowCount ?? 0;
  }

  // Marca os não-conforme (marcador JSONB; status segue 'pendente' → aba Não
  // conformidade). Read-modify-write por linha (pg-mem-safe; sem operador ||).
  const nowIso = new Date().toISOString();
  for (const { id, dados, motivos } of toMarcar) {
    const next = { ...(dados && typeof dados === "object" ? dados : {}), nao_conformidade: { at: nowIso, motivos, by: "reconcile" } };
    const { rowCount } = await withPgClient((client) =>
      client.query(
        `UPDATE public.pending_driver_registrations
            SET dados = $1::jsonb, updated_at = now()
          WHERE id = $2 AND status = 'pendente'`,
        [JSON.stringify(next), id],
      ),
    );
    if (rowCount) {
      result.naoConformes += 1;
      result.updated += 1;
    }
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
              `Conciliação (3 conformes): ${result.concluidos} concluído(s) · ${result.naoConformes} em não conformidade`,
              `${result.checked} cadastro(s) verificado(s) no Angellira (motorista+cavalo+carreta)` +
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

/**
 * Status da conexão do número WhatsApp. `instance` opcional: omitido → número
 * de Cargas (comportamento original); informado → outra instância (ex.: Repom).
 */
export async function getWhatsappStatus({ instance } = {}) {
  if (!isEvolutionConfigured()) return { configured: false, state: "not_configured", instance: null };
  try {
    const s = await getWhatsappConnectionState({ instance });
    return { configured: true, ...s };
  } catch (err) {
    return { configured: true, state: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Inicia o pareamento. Sem `number` → modo QR (base64 p/ escanear). Com `number`
 * → modo código (pairingCode de 8 caracteres p/ digitar no WhatsApp, sem câmera).
 * `instance` opcional (default = número de Cargas).
 */
export async function connectWhatsapp({ number, instance } = {}) {
  if (!isEvolutionConfigured()) {
    throw new ValidationError("Gateway WhatsApp não configurado (EVOLUTION_API_TOKEN ausente).");
  }
  return connectWhatsappInstance({ number, instance });
}

/** Desconecta o número atual (logout da instância; default = Cargas). */
export async function disconnectWhatsapp({ instance } = {}) {
  if (!isEvolutionConfigured()) throw new ValidationError("Gateway WhatsApp não configurado.");
  return logoutWhatsappInstance({ instance });
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

// ── Cache + single-flight do sino ────────────────────────────────────────────
// O feed é GLOBAL: operator_notifications não tem coluna de usuário/operador
// (migration 20260708120000) e `seen`/`seen_at` são flags globais — é disso que
// o "Dispensar para todos" depende. Logo UMA entrada de módulo serve todos os
// operadores (não há chave por usuário a incluir).
// O sino vive no DashboardHeader (renderizado em cada página do operador) com
// poll de 30s e remonta a cada navegação → N operadores × N abas executavam
// DUAS queries sem cache nenhum, uma delas ordenando a tabela inteira. Com o
// cache, N polls concorrentes viram UMA execução (duas queries) por janela.
//
// ⚠ TTL 45s > poll de 30s (margem de 1,5×). NÃO REDUZIR ABAIXO DO POLL.
// Medição em produção (pg_stat_statements, delta de 1091s) com o TTL antigo de
// 15s: a query do sino rodou 35 vezes = uma a cada 31s, exatamente o poll →
// ZERO cache hit. TTL menor que o intervalo que DIRIGE as chamadas não serve
// nada: quando o próximo poll chega, a entrada já expirou. Com 45s, um poll de
// 30s alterna hit/miss → uma execução a cada 60s (metade das leituras), e a
// margem absorve o jitter medido (31s) e as rajadas de remonte por navegação.
// Custo: o alarme de spot pode aparecer até 45s mais tarde — irrelevante ao lado
// do scanner que CRIA a notificação a cada 3 min. 0 em teste (default), a menos
// que o teste force o knob.
const OPERATOR_NOTIFICATIONS_POLL_MS = 30_000; // frontend/src/components/operator/NotificationsBell.tsx
const OPERATOR_NOTIFICATIONS_TTL_MS = 45_000;
// Exportados só para o teste amarrar TTL > poll (o teste que provava dedupe em
// chamadas colada-a-colada passava mesmo com o TTL quebrado de 15s).
export const __notificationsCacheTiming = Object.freeze({
  pollMs: OPERATOR_NOTIFICATIONS_POLL_MS,
  ttlMs: OPERATOR_NOTIFICATIONS_TTL_MS,
});
// A chave inclui o LIMIT efetivo (já clampado): ele chega da query string
// (handlers.js) e define o tamanho do payload — ignorá-lo entregaria 40 itens a
// quem pediu 200.
let _notificationsInFlight = null;
let _notificationsCache = { at: 0, limit: 0, payload: null };
// Epoch das mutações (visto/limpar): uma leitura que COMEÇOU antes do write não
// pode repovoar o cache com as linhas pré-mutação, senão o badge vermelho
// voltaria por até TTL (o front invalida e refaz o fetch na hora).
let _notificationsEpoch = 0;

function getOperatorNotificationsCacheTtlMs() {
  const raw = Number.parseInt(process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return OPERATOR_NOTIFICATIONS_TTL_MS; // default produção (> poll de 30s)
}

/** Invalida o sino (as mutações abaixo leem o próprio write). Nunca lança. */
function bustOperatorNotificationsCache() {
  _notificationsEpoch += 1;
  _notificationsCache = { at: 0, limit: 0, payload: null };
}

/** Hook de teste: zera o estado de módulo do cache do sino. */
export function __resetOperatorNotificationsCache() {
  _notificationsInFlight = null;
  _notificationsCache = { at: 0, limit: 0, payload: null };
  _notificationsEpoch = 0;
}

/**
 * Leitura crua do sino. Devolve `cacheable: false` no fallback de tabela
 * ausente (schema degradado não deve grudar por TTL).
 */
async function loadOperatorNotifications(cap) {
  try {
    const payload = await withPgClient(async (client) => {
      // Duas queries de propósito. Dobrar o count numa subquery no SELECT
      // (`(SELECT count(*) ...) AS unseen_count`) cortaria um round trip no
      // Postgres, mas o pg-mem do harness devolve UMA linha só, toda NULL,
      // para essa forma — o endpoint ficaria sem cobertura confiável. Quem
      // reduz o custo aqui é o cache acima (N polls → 1 execução por janela).
      const { rows: unseen } = await client.query(
        `SELECT count(*) AS n FROM public.operator_notifications WHERE seen = false`,
      );
      const { rows } = await client.query(
        `SELECT id, kind, title, body, metadata, seen, seen_at, created_at
           FROM public.operator_notifications
          ORDER BY created_at DESC
          LIMIT $1`,
        [cap],
      );
      return { unseenCount: Number(unseen[0]?.n ?? 0), items: rows };
    });
    return { payload, cacheable: true };
  } catch (err) {
    // Tabela pode não existir ainda (migration não aplicada).
    if (err?.code === "42P01") return { payload: { unseenCount: 0, items: [] }, cacheable: false };
    throw err;
  }
}

export async function listOperatorNotifications({ limit = 40 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 40));
  const ttl = getOperatorNotificationsCacheTtlMs();
  if (ttl <= 0) return (await loadOperatorNotifications(cap)).payload;

  const now = Date.now();
  if (_notificationsCache.payload && _notificationsCache.limit === cap && now - _notificationsCache.at < ttl) {
    return { ..._notificationsCache.payload };
  }
  if (_notificationsInFlight && _notificationsInFlight.limit === cap) {
    return { ...(await _notificationsInFlight.promise) };
  }

  const epoch = _notificationsEpoch;
  const promise = (async () => {
    const { payload, cacheable } = await loadOperatorNotifications(cap);
    if (cacheable && _notificationsEpoch === epoch) {
      _notificationsCache = { at: Date.now(), limit: cap, payload };
    }
    return payload;
  })();
  _notificationsInFlight = { limit: cap, promise };

  try {
    return { ...(await promise) };
  } finally {
    if (_notificationsInFlight?.promise === promise) _notificationsInFlight = null;
  }
}

// DC-279 (dev/teste) — cria notificação(ões) de spot REAIS para testar o fluxo
// completo (sino persistente + som + card) sem depender do feed SPX ao vivo. O
// gate fica no handler HTTP (ENABLE_TEST_NOTIFICATIONS), então não roda em prod.
export async function createTestSpotNotifications({ count = 1 } = {}) {
  const total = Math.max(1, Math.min(10, Number(count) || 1));
  return withPgClient(async (client) => {
    for (let i = 0; i < total; i += 1) {
      const lh = `LT-TESTE-${Date.now()}-${i}`;
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('new_spot', $1, $2, $3::jsonb)`,
        [
          "[TESTE] Nova carga spot: Simões Filho/BA → Jaboatão dos Guararapes/PE",
          "TESTE · aceite na Programação",
          JSON.stringify({
            lh,
            origem: "Simões Filho/BA",
            destino: "Jaboatão dos Guararapes/PE",
            source: "teste",
            test: true,
          }),
        ],
      );
    }
    bustOperatorNotificationsCache();
    return { ok: true, created: total };
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
  bustOperatorNotificationsCache();
  return { updated: rowCount ?? 0 };
}

export async function deleteOperatorNotifications({ ids, all } = {}) {
  if (all) {
    const { rowCount } = await withPgClient((client) =>
      client
        .query(`DELETE FROM public.operator_notifications`)
        .catch((err) => (err?.code === "42P01" ? { rowCount: 0 } : Promise.reject(err))),
    );
    bustOperatorNotificationsCache();
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
  bustOperatorNotificationsCache();
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
  bustOperatorNotificationsCache();
  return { updated: rowCount ?? 0 };
}

// ─── Chat WhatsApp (lista de conversas + histórico + envio manual) ────────────

// ── Cache + single-flight da lista de conversas ──────────────────────────────
// A lista também é GLOBAL: whatsapp_messages não tem coluna de operador/usuário
// (migration 20260708120000) e a query não recebe nenhum predicado por usuário —
// todos os operadores veem as mesmas conversas, então uma entrada de módulo
// serve todos (nada a chavear por usuário).
// Cada execução varre whatsapp_messages DUAS vezes (DISTINCT ON (phone) +
// agregado de não lidas) e o ChatPanel faz poll de 20s enquanto a aba Chat está
// aberta, sem nenhum dedupe entre operadores.
//
// ⚠ TTL 45s > poll de 20s (margem de 2,25×). NÃO REDUZIR ABAIXO DO POLL.
// O TTL antigo de 10s era menor que o poll de 20s → toda janela já havia
// expirado quando o poll seguinte chegava (mesmo defeito medido no sino: 35
// execuções em 1091s, uma por poll, zero hit). Com 45s, um poll de 20s dá
// hit-hit-miss → uma execução a cada 60s. Custo: uma conversa NOVA (ou o badge
// de não lidas de outra conversa) pode demorar até 45s para aparecer na lista.
// A conversa ABERTA não é afetada: listWhatsappMessages faz poll de 8s e NÃO
// passa por cache, e qualquer envio/marcação de lida busta esta entrada na hora.
const OPERATOR_CHAT_CONVERSATIONS_POLL_MS = 20_000; // frontend/src/components/operator/ChatPanel.tsx
const OPERATOR_CHAT_CONVERSATIONS_TTL_MS = 45_000;
/** Exportado só para o teste amarrar TTL > poll. */
export const __chatConversationsCacheTiming = Object.freeze({
  pollMs: OPERATOR_CHAT_CONVERSATIONS_POLL_MS,
  ttlMs: OPERATOR_CHAT_CONVERSATIONS_TTL_MS,
});
// Só o caminho SEM BUSCA é cacheado (busca é digitada, nunca faz poll → evita
// Map ilimitado por termo) e a chave inclui o LIMIT efetivo, que chega da query
// string (handlers.js) e define tanto o `LIMIT` do SQL quanto o
// `items.slice(0, cap)` — sem isso um `?limit=200` receberia 60 itens.
let _convInFlight = null;
let _convCache = { at: 0, limit: 0, payload: null };
// Epoch das escritas (mensagem nova / marcação de lida): leitura que começou
// antes do write não repovoa o cache com o estado antigo.
let _convEpoch = 0;

function getChatConversationsCacheTtlMs() {
  const raw = Number.parseInt(process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return OPERATOR_CHAT_CONVERSATIONS_TTL_MS; // default produção (> poll de 20s)
}

/**
 * Invalida a lista de conversas (mensagem nova, envio manual, marcação de
 * lida). Síncrona e nunca lança — é chamada de caminhos best-effort.
 */
export function bustWhatsappConversationsCache() {
  _convEpoch += 1;
  _convCache = { at: 0, limit: 0, payload: null };
}

/** Hook de teste: zera o estado de módulo do cache de conversas. */
export function __resetWhatsappConversationsCache() {
  _convInFlight = null;
  _convCache = { at: 0, limit: 0, payload: null };
  _convEpoch = 0;
}

/**
 * Lista de conversas (uma por telefone) com última mensagem e count de não lidas.
 *
 * Sem busca → só conversas existentes (WhatsApp-like), mais recente primeiro
 * (caminho do poll, servido pelo cache de módulo acima).
 * Com busca → une (conversas casando) + (motoristas cadastrados casando por
 * nome/CPF/telefone) — permite iniciar chat com qualquer motorista do sistema
 * mesmo sem histórico prévio. NÃO passa pelo cache.
 */
export async function listWhatsappConversations({ limit = 60, search } = {}) {
  const searchTerm = String(search || "").trim();
  const cap = Math.max(1, Math.min(200, Number(limit) || 60));
  const ttl = getChatConversationsCacheTtlMs();
  if (ttl <= 0 || searchTerm) return (await loadWhatsappConversations({ cap, searchTerm })).payload;

  const now = Date.now();
  if (_convCache.payload && _convCache.limit === cap && now - _convCache.at < ttl) {
    return { ..._convCache.payload };
  }
  if (_convInFlight && _convInFlight.limit === cap) {
    return { ...(await _convInFlight.promise) };
  }

  const epoch = _convEpoch;
  const promise = (async () => {
    const { payload, cacheable } = await loadWhatsappConversations({ cap, searchTerm: "" });
    if (cacheable && _convEpoch === epoch) {
      _convCache = { at: Date.now(), limit: cap, payload };
    }
    return payload;
  })();
  _convInFlight = { limit: cap, promise };

  try {
    return { ...(await promise) };
  } finally {
    if (_convInFlight?.promise === promise) _convInFlight = null;
  }
}

/**
 * Leitura crua da lista de conversas. Devolve `cacheable: false` no fallback de
 * tabela ausente (schema degradado não deve grudar por TTL).
 */
async function loadWhatsappConversations({ cap, searchTerm }) {
  const searchDigits = searchTerm.replace(/\D/g, "");

  const payload = await withPgClient(async (client) => {
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
      // Tabela pode não existir ainda (migration não aplicada) — null sinaliza
      // o fallback para o wrapper (que não cacheia).
      if (err?.code === "42P01") return null;
      throw err;
    }
  });
  return payload ? { payload, cacheable: true } : { payload: { items: [] }, cacheable: false };
}

export async function listWhatsappMessages({ phone, limit = 200 } = {}) {
  const p = onlyDigits(phone);
  if (!p) throw new ValidationError("Telefone obrigatório.");
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  return withPgClient(async (client) => {
    try {
      const { rows } = await client.query(
        `SELECT id, direction, external_id, phone, driver_key, text, message_type, status, timestamp
           FROM public.whatsapp_messages
          WHERE phone = $1
          ORDER BY timestamp ASC
          LIMIT $2`,
        [p, cap],
      );
      // Marca as IN como lidas. Com poll de 8s do ChatPanel isso era um UPDATE
      // (e WAL) por tick mesmo com a conversa toda lida — só roda quando há o
      // que marcar. A janela é `timestamp ASC LIMIT n`, ou seja é truncada pelas
      // mensagens MAIS NOVAS, exatamente onde ficam as não lidas: quando ela
      // estoura (rows.length >= cap) o UPDATE roda de qualquer jeito, senão o
      // comportamento mudaria.
      const truncated = rows.length >= cap;
      const hasUnreadIn = rows.some((r) => r.direction === "in" && r.status !== "read");
      if (truncated || hasUnreadIn) {
        const res = await client
          .query(
            `UPDATE public.whatsapp_messages
                SET status = 'read'
              WHERE phone = $1 AND direction = 'in' AND status <> 'read'`,
            [p],
          )
          .catch(() => {});
        // O badge de não lidas vive na lista de conversas (cacheada) — o
        // operador precisa ver zerar na hora. `res` pode ser undefined (o
        // .catch acima engole o erro).
        if ((res?.rowCount ?? 0) > 0) bustWhatsappConversationsCache();
      }
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
  // A OUT recém-gravada muda a última mensagem da conversa — o operador tem que
  // ver na hora, não no fim do TTL.
  bustWhatsappConversationsCache();
  return { ok: true };
}
