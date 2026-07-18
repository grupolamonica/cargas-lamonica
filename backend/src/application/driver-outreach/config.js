/**
 * driver-outreach — configuração dos guardrails de ENVIO automático (Wave B/C).
 *
 * Fonte da verdade: tabela driver_outreach_settings (controlada pela tela do
 * operador). As env vars DRIVER_OUTREACH_* são apenas FALLBACK (quando a tabela
 * ainda não existe) + timing de boot (poll/scan). Tudo desligado por padrão.
 *
 * Gatilhos FRIOS (churn/carga de retorno — contato não solicitado, maior risco
 * de ban do número) exigem cold_enabled=true.
 */

import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

const bool = (name, dflt) => {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return dflt;
  return raw === "true" || raw === "1" || raw === "yes";
};
const int = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
};

/** Gatilhos FRIOS (contato não solicitado) — exigem cold_enabled. */
export const COLD_TRIGGERS = new Set(["churn", "return_load"]);

function isMissingTable(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

/** Defaults vindos do env (fallback + timing de boot). */
function envConfig() {
  return {
    enabled: bool("DRIVER_OUTREACH_ENABLED", false),
    coldEnabled: bool("DRIVER_OUTREACH_COLD_ENABLED", false),
    dailyCap: int("DRIVER_OUTREACH_DAILY_CAP", 50),
    quietStartHour: int("DRIVER_OUTREACH_QUIET_START_HOUR", 8),
    quietEndHour: int("DRIVER_OUTREACH_QUIET_END_HOUR", 20),
    pollSeconds: int("DRIVER_OUTREACH_POLL_SECONDS", 30),
    batchSize: int("DRIVER_OUTREACH_BATCH_SIZE", 10),
    maxAttempts: int("DRIVER_OUTREACH_MAX_ATTEMPTS", 3),
    scanIntervalMin: int("DRIVER_OUTREACH_SCAN_INTERVAL_MIN", 60),
    scanMaxCandidates: int("DRIVER_OUTREACH_SCAN_MAX_CANDIDATES", 60),

    // ── Anti-ban / pacing ──────────────────────────────────────────────────
    // Intervalo humano entre um envio proativo e o próximo (drip). O enqueue
    // escalona next_attempt_at usando um valor aleatório nesta faixa.
    // Alinhado ao cap horário: ~1 a cada 3-7 min (média 5 min ≈ 12/hora), para
    // o drip não agendar mais rápido do que o worker deixa enviar.
    minGapSeconds: int("DRIVER_OUTREACH_MIN_GAP_SECONDS", 180),
    maxGapSeconds: int("DRIVER_OUTREACH_MAX_GAP_SECONDS", 420),
    // Cap por HORA (além do diário) — espalha o volume ao longo do dia.
    hourlyCap: int("DRIVER_OUTREACH_HOURLY_CAP", 12),
    // Máx. de envios PROATIVOS por ciclo do worker (evita rajada se houver
    // backlog acumulado). Transacionais não contam.
    sendsPerCycle: int("DRIVER_OUTREACH_SENDS_PER_CYCLE", 2),
    // "Digitando…" simulado pelo Evolution antes de enviar (ms) — faixa aleatória.
    typingMinMs: int("DRIVER_OUTREACH_TYPING_MIN_MS", 1200),
    typingMaxMs: int("DRIVER_OUTREACH_TYPING_MAX_MS", 3500),
    // Aquecimento do número: cap diário cresce nos primeiros dias.
    warmupEnabled: bool("DRIVER_OUTREACH_WARMUP_ENABLED", false),
    warmupStartCap: int("DRIVER_OUTREACH_WARMUP_START_CAP", 20),
    warmupStepPerDay: int("DRIVER_OUTREACH_WARMUP_STEP_PER_DAY", 10),

    // Chamado automático de cargas órfãs (route-need).
    routeNeedEnabled: bool("DRIVER_OUTREACH_ROUTE_NEED_ENABLED", false),
    routeNeedDaysAhead: int("DRIVER_OUTREACH_ROUTE_NEED_DAYS_AHEAD", 3),
    routeNeedWaveSize: int("DRIVER_OUTREACH_ROUTE_NEED_WAVE_SIZE", 5),
    // Horas sem aceite antes de liberar a próxima onda de motoristas.
    routeNeedWaveGapHours: int("DRIVER_OUTREACH_ROUTE_NEED_WAVE_GAP_HOURS", 3),
    // Teto de motoristas contatados por carga órfã (todas as ondas somadas).
    routeNeedMaxDrivers: int("DRIVER_OUTREACH_ROUTE_NEED_MAX_DRIVERS", 20),
    // Teto de cargas órfãs processadas por varredura (as mais urgentes primeiro)
    // — evita enfileirar centenas de convites de uma vez.
    routeNeedMaxCargasPerScan: int("DRIVER_OUTREACH_ROUTE_NEED_MAX_CARGAS_PER_SCAN", 15),
  };
}

/** Inteiro aleatório em [min, max] (inclusivo). */
export function randomInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Gap de drip (ms) entre um envio proativo e o próximo, com jitter. */
export function computeDripGapMs(cfg) {
  return randomInt(cfg.minGapSeconds, cfg.maxGapSeconds) * 1000;
}

/** Delay de "digitando…" (ms) para um envio, com jitter. */
export function pickTypingDelayMs(cfg) {
  return randomInt(cfg.typingMinMs, cfg.typingMaxMs);
}

/**
 * Cap diário EFETIVO. Com warmup ligado, cresce a partir de warmupStartCap
 * (+warmupStepPerDay por dia decorrido) até o teto dailyCap.
 * @param {number} daysSinceStart dias desde o primeiro envio (0 = hoje/primeiro dia)
 */
export function effectiveDailyCap(cfg, daysSinceStart = 0) {
  if (!cfg.warmupEnabled) return cfg.dailyCap;
  const ramp = cfg.warmupStartCap + cfg.warmupStepPerDay * Math.max(0, daysSinceStart);
  return Math.max(1, Math.min(cfg.dailyCap, ramp));
}

/** Lê a linha singleton de settings (id=1). null se não existir. */
export async function loadOutreachSettings(client) {
  try {
    const { rows } = await client.query(
      `SELECT enabled, cold_enabled, daily_cap, quiet_start_hour, quiet_end_hour,
              route_need_enabled, route_need_days_ahead, route_need_wave_size, updated_at
         FROM public.driver_outreach_settings WHERE id = 1`,
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/**
 * Config efetivo: defaults do env sobrescritos pela linha de settings do banco
 * (quando existe). Sem client → só env (usado no boot para timing).
 */
export async function getOutreachConfig(client) {
  const env = envConfig();
  if (!client) return env;
  const row = await loadOutreachSettings(client);
  if (!row) return env;
  return {
    ...env,
    enabled: Boolean(row.enabled),
    coldEnabled: Boolean(row.cold_enabled),
    dailyCap: Number(row.daily_cap),
    quietStartHour: Number(row.quiet_start_hour),
    quietEndHour: Number(row.quiet_end_hour),
    routeNeedEnabled:
      row.route_need_enabled == null ? env.routeNeedEnabled : Boolean(row.route_need_enabled),
    routeNeedDaysAhead:
      row.route_need_days_ahead == null ? env.routeNeedDaysAhead : Number(row.route_need_days_ahead),
    routeNeedWaveSize:
      row.route_need_wave_size == null ? env.routeNeedWaveSize : Number(row.route_need_wave_size),
  };
}

const SETTING_COLUMNS = [
  "enabled",
  "cold_enabled",
  "daily_cap",
  "quiet_start_hour",
  "quiet_end_hour",
  "route_need_enabled",
  "route_need_days_ahead",
  "route_need_wave_size",
];

/** Aplica um patch parcial na linha singleton (cria se não existir). */
export async function updateOutreachSettings(client, patch = {}, updatedBy = null) {
  await client.query(
    `INSERT INTO public.driver_outreach_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );
  const sets = [];
  const vals = [];
  let i = 1;
  for (const col of SETTING_COLUMNS) {
    if (patch[col] !== undefined && patch[col] !== null) {
      sets.push(`${col} = $${i++}`);
      vals.push(patch[col]);
    }
  }
  if (sets.length) {
    vals.push(updatedBy);
    await client.query(
      `UPDATE public.driver_outreach_settings SET ${sets.join(", ")}, updated_at = now(), updated_by = $${i} WHERE id = 1`,
      vals,
    );
  }
  return loadOutreachSettings(client);
}

/** Backoff por tentativa (ms): 1min, 5min, 30min. */
export function backoffMs(retryCount) {
  const schedule = [60_000, 300_000, 1_800_000];
  return schedule[Math.min(retryCount, schedule.length - 1)];
}

/** true se o horário atual (BRT) está DENTRO da janela permitida de envio. */
export function isWithinSendWindow(cfg, now = new Date()) {
  const { timeIso } = getSaoPauloWallClock(now);
  const hour = Number(String(timeIso).slice(0, 2));
  if (cfg.quietStartHour === cfg.quietEndHour) return true; // 24h
  return hour >= cfg.quietStartHour && hour < cfg.quietEndHour;
}

/** true se o gatilho pode ser enviado dado o config (frio exige coldEnabled). */
export function isTriggerAllowed(trigger, cfg) {
  if (!COLD_TRIGGERS.has(trigger)) return true;
  return Boolean(cfg.coldEnabled);
}
