/**
 * route-need — chamado AUTOMÁTICO de cargas órfãs.
 *
 * Quando uma carga OPEN está sem candidatura e o carregamento se aproxima
 * (janela configurável pelo operador), o sistema chama motoristas que já
 * fizeram aquela rota E não estão em viagem, em ondas de N (escalonado).
 *
 * Fluxo de conversa (no webhook):
 *   invite  → motorista aceita → pergunta "que dia e horário?"
 *   awaiting_schedule → motorista responde (parser NLP) → acha a carga da rota
 *                       com a data mais próxima do que ele pediu → oferta
 *   offered → motorista confirma → cria candidatura (load_public_leads)
 *
 * "Em viagem" = motorista é o sheet_motorista/alloc_motorista de uma carga com
 * código de viagem (sheet_lh: B10…/LH…/LT…) e status ATIVO (≠ DESCARREGADO/
 * CANCELADO/NO SHOW/vazio).
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";
import { normalizeText } from "../../domain/driver-outreach/detection.js";
import { parseSchedulePreference } from "../../domain/driver-outreach/schedule-nlp.js";
import { renderMessage, buildCargoDetails, firstName, isMessageEnabled } from "./message-templates.js";
import { getOutreachConfig, computeDripGapMs } from "./config.js";
import { resolveMassAudience, createLeadFromMassAccept } from "./mass-outreach.js";

const onlyDigits = (v) => String(v || "").replace(/\D/g, "");

function toIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// Status de viagem que indicam motorista OCUPADO (não é fim de viagem).
const TRIP_DONE_STATUSES = new Set(["DESCARREGADO", "CANCELADO", "NO SHOW", ""]);

// ─── Detecção: motoristas em viagem ───────────────────────────────────────────

/**
 * Conjunto de nomes (normalizados) de motoristas atualmente EM VIAGEM.
 * @returns {Promise<Set<string>>}
 */
export async function listDriversOnTrip(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT sheet_motorista, alloc_motorista
       FROM public.cargas
      WHERE coalesce(sheet_lh, '') <> ''
        AND coalesce(sheet_status, '') NOT IN ('DESCARREGADO', 'CANCELADO', 'NO SHOW', '')
        AND sheet_status IS NOT NULL`,
  );
  const set = new Set();
  for (const r of rows) {
    if (r.sheet_motorista) set.add(normalizeText(r.sheet_motorista));
    if (r.alloc_motorista) set.add(normalizeText(r.alloc_motorista));
  }
  return set;
}

// ─── Cargas órfãs (OPEN, sem candidatura, carregando em breve) ────────────────

/**
 * @param {object} client
 * @param {{ daysAhead:number, todayIso:string }} opts
 * @returns {Promise<Array>}
 */
export async function findOrphanCargasNeedingDrivers(client, { daysAhead, todayIso } = {}) {
  const days = Math.max(0, Math.min(60, Number(daysAhead) || 3));
  const today = todayIso || getSaoPauloWallClock().dateIso;
  const { rows } = await client.query(
    `SELECT c.id, c.origem, c.destino, c.data, c.horario, c.valor, c.bonus, c.perfil
       FROM public.cargas c
      WHERE c.status = 'OPEN'
        AND coalesce(c.origem,'') <> '' AND coalesce(c.destino,'') <> ''
        AND c.data IS NOT NULL
        AND c.data >= $1::date
        AND c.data <= ($1::date + ($2 || ' days')::interval)
        AND NOT EXISTS (
          SELECT 1 FROM public.load_public_leads l
           WHERE l.load_id = c.id
             AND l.status IN ('PRE_REGISTERED','QUEUED','APPROVED')
        )
      ORDER BY c.data ASC, c.horario ASC NULLS LAST`,
    [today, String(days)],
  );
  return rows;
}

// ─── Motoristas elegíveis para uma rota ───────────────────────────────────────

/**
 * Drivers que já rodaram a rota (planilha + candidaturas), COM telefone, que
 * NÃO estão em viagem e NÃO estão em opt-out. Preserva a ordem de recência
 * aproximada de resolveMassAudience.
 */
export async function eligibleDriversForRoute(client, { origem, destino } = {}) {
  if (!origem || !destino) return [];
  const routeKey = `${origem}→${destino}`;
  const audience = await resolveMassAudience(client, { audience: "routes", routes: [routeKey] });
  if (!audience.length) return [];

  const onTrip = await listDriversOnTrip(client);

  // opt-out por driver_key
  const keys = audience.map((d) => onlyDigits(d.cpf) || normalizeText(d.nome)).filter(Boolean);
  const optedOut = new Set();
  if (keys.length) {
    const ph = keys.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await client
      .query(`SELECT driver_key FROM public.driver_outreach_optout WHERE driver_key IN (${ph})`, keys)
      .catch(() => ({ rows: [] }));
    for (const r of rows) optedOut.add(r.driver_key);
  }

  return audience.filter((d) => {
    if (!d.phone) return false;
    if (onTrip.has(normalizeText(d.nome))) return false;
    const key = onlyDigits(d.cpf) || normalizeText(d.nome);
    if (optedOut.has(key)) return false;
    return true;
  });
}

// ─── Mensagens (via central de templates editável) ────────────────────────────

export function composeRouteNeedInvite({ nome, origem, destino }) {
  return renderMessage("route_need_invite", { nome: firstName(nome), rota: `${origem} → ${destino}` });
}

export function composeAskSchedule({ nome, origem, destino }) {
  return renderMessage("route_need_ask_schedule", { nome: firstName(nome), rota: `${origem} → ${destino}` });
}

export function composeScheduleOffer({ nome, load, requested, exact }) {
  return renderMessage("route_need_offer", {
    nome: firstName(nome),
    detalhes: buildCargoDetails(load),
    ajuste: exact ? "" : " (a mais próxima do que você pediu)",
  });
}

export function composeNoLoadForSchedule({ nome, origem, destino }) {
  return renderMessage("route_need_no_load", { nome: firstName(nome), rota: `${origem} → ${destino}` });
}

export function composeRouteNeedConfirm({ nome, load, duplicate }) {
  return renderMessage("route_need_confirm", {
    nome: firstName(nome),
    detalhes: buildCargoDetails(load),
  });
}

// ─── Matching: carga da rota mais próxima do que o motorista pediu ────────────

/**
 * Acha a carga OPEN da rota com a data mais próxima da preferência do motorista.
 * @param {object} pref  saída de parseSchedulePreference
 * @returns {Promise<{load:object|null, exact:boolean}>}
 */
export async function findClosestLoadForSchedule(client, { origem, destino, pref, todayIso } = {}) {
  const today = todayIso || getSaoPauloWallClock().dateIso;
  const { rows } = await client.query(
    `SELECT id, origem, destino, data, horario, valor, bonus, perfil, eixos
       FROM public.cargas
      WHERE status = 'OPEN'
        AND origem = $1 AND destino = $2
        AND data IS NOT NULL AND data >= $3::date
      ORDER BY data ASC, horario ASC NULLS LAST`,
    [origem, destino, today],
  );
  if (!rows.length) return { load: null, exact: false };

  const loads = rows.map((r) => ({ ...r, iso: toIso(r.data) }));

  // asap / any / period_only / range sem alvo específico → a mais cedo.
  if (!pref || pref.kind === "asap" || pref.kind === "any" || pref.kind === "period_only") {
    return { load: loads[0], exact: false };
  }

  if (pref.kind === "range" && pref.dateFrom && pref.dateTo) {
    const inRange = loads.filter((l) => l.iso >= pref.dateFrom && l.iso <= pref.dateTo);
    if (inRange.length) return { load: inRange[0], exact: true };
    // nenhuma no intervalo → a mais próxima do início do intervalo
    const target = pref.dateFrom;
    return { load: closestTo(loads, target), exact: false };
  }

  if (pref.kind === "date" && pref.dateIso) {
    const exactMatch = loads.find((l) => l.iso === pref.dateIso);
    if (exactMatch) return { load: exactMatch, exact: true };
    return { load: closestTo(loads, pref.dateIso), exact: false };
  }

  // fallback
  return { load: loads[0], exact: false };
}

/** carga com a data mais próxima do alvo (prefere >= alvo em empate). */
function closestTo(loads, targetIso) {
  const t = new Date(`${targetIso}T12:00:00Z`).getTime();
  let best = null;
  let bestScore = Infinity;
  for (const l of loads) {
    const d = new Date(`${l.iso}T12:00:00Z`).getTime();
    const diff = Math.abs(d - t);
    // tie-break: prefere futuro (d >= t) com um empurrãozinho
    const score = diff + (d < t ? 1 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best;
}

// ─── Conversa: localizar estado ativo ─────────────────────────────────────────

/**
 * Retorna a linha route-need mais recente do motorista com conversa em aberto.
 * @returns {Promise<{id:string, metadata:object, stage:string}|null>}
 */
export async function findRouteNeedConversation(client, { phone, driverKey } = {}) {
  const p = onlyDigits(phone);
  const pNoDdi = p.startsWith("55") ? p.slice(2) : p;
  const dk = String(driverKey || "").trim();
  const { rows } = await client.query(
    `SELECT id, metadata, phone, driver_key, created_at
       FROM public.pending_driver_outreach
      WHERE trigger LIKE 'route-need:%'
        AND coalesce(metadata->>'stage','') IN ('invited','awaiting_schedule','offered')
        AND (
          regexp_replace(coalesce(phone,''), '\\D', '', 'g') IN ($1, $2)
          OR ($3 <> '' AND driver_key = $3)
        )
        AND created_at > now() - interval '5 days'
      ORDER BY created_at DESC
      LIMIT 1`,
    [p, pNoDdi, dk],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, metadata: row.metadata || {}, stage: (row.metadata || {}).stage || "invited" };
}

/** Atualiza o metadata (merge) + stage de uma linha route-need. */
export async function updateRouteNeedStage(client, { id, patch } = {}) {
  await client.query(
    `UPDATE public.pending_driver_outreach
        SET metadata = coalesce(metadata,'{}'::jsonb) || $2::jsonb
      WHERE id = $1`,
    [id, JSON.stringify(patch || {})],
  );
}

// ─── Scanner: enfileira ondas de motoristas ───────────────────────────────────

/**
 * Varre cargas órfãs e enfileira a próxima onda de motoristas por carga.
 * Ondas escalonadas: só libera a próxima se a anterior já passou de
 * routeNeedWaveGapHours sem ninguém aceitar. Respeita teto por carga.
 */
export async function scanAndEnqueueRouteNeeds({ now = new Date() } = {}) {
  return withPgClient(async (client) => {
    const cfg = await getOutreachConfig(client);
    if (!cfg.routeNeedEnabled) return { skipped: "disabled", enqueued: 0, cargas: 0 };
    // Mensagem de convite desligada na central de templates → não dispara nada.
    if (!isMessageEnabled("route_need_invite")) return { skipped: "message_off", enqueued: 0, cargas: 0 };

    const todayIso = getSaoPauloWallClock(now).dateIso;
    const allOrphans = await findOrphanCargasNeedingDrivers(client, {
      daysAhead: cfg.routeNeedDaysAhead,
      todayIso,
    });
    if (!allOrphans.length) return { enqueued: 0, cargas: 0 };
    // Processa só as mais urgentes por varredura (já vêm ordenadas por data ASC).
    const maxCargas = Math.max(1, cfg.routeNeedMaxCargasPerScan || 15);
    const orphans = allOrphans.slice(0, maxCargas);
    const orphansSkipped = allOrphans.length - orphans.length;

    const waveSize = Math.max(1, cfg.routeNeedWaveSize);
    const maxDrivers = Math.max(waveSize, cfg.routeNeedMaxDrivers || 20);
    const gapMs = Math.max(1, cfg.routeNeedWaveGapHours || 3) * 60 * 60 * 1000;

    let totalEnqueued = 0;
    let cargasTouched = 0;

    for (const cargo of orphans) {
      const trigger = `route-need:${cargo.id}`.slice(0, 64);

      // Quem já foi contatado para ESTA carga + quando foi o último envio.
      const { rows: already } = await client.query(
        `SELECT driver_key, status, sent_at, created_at, coalesce(metadata->>'stage','') AS stage
           FROM public.pending_driver_outreach
          WHERE trigger = $1`,
        [trigger],
      );
      // Se alguém já está em conversa avançada (aceitou), não manda mais ondas.
      const someoneEngaged = already.some((r) =>
        ["awaiting_schedule", "offered", "converted"].includes(r.stage),
      );
      if (someoneEngaged) continue;
      if (already.length >= maxDrivers) continue;

      // Onda em andamento? (último envio há menos de gapMs) → espera.
      const lastSentMs = already
        .map((r) => (r.sent_at ? new Date(r.sent_at).getTime() : r.created_at ? new Date(r.created_at).getTime() : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      if (lastSentMs && now.getTime() - lastSentMs < gapMs) continue;

      // Motoristas elegíveis ainda não contatados.
      const contactedKeys = new Set(already.map((r) => r.driver_key));
      const eligible = await eligibleDriversForRoute(client, {
        origem: cargo.origem,
        destino: cargo.destino,
      });
      const fresh = eligible.filter((d) => {
        const key = onlyDigits(d.cpf) || normalizeText(d.nome);
        return key && !contactedKeys.has(key);
      });
      if (!fresh.length) continue;

      const wave = fresh.slice(0, waveSize);

      // Drip escalonado atrás do backlog pendente.
      const { rows: maxRows } = await client
        .query(
          `SELECT GREATEST(now(), COALESCE(max(next_attempt_at), now())) AS base
             FROM public.pending_driver_outreach WHERE status = 'pending'`,
        )
        .catch(() => ({ rows: [{ base: now }] }));
      let cursorMs = new Date(maxRows[0]?.base || now).getTime();

      const waveIndex =
        already.length === 0 ? 1 : Math.floor(already.length / waveSize) + 1;

      for (const d of wave) {
        const key = onlyDigits(d.cpf) || normalizeText(d.nome);
        const text = composeRouteNeedInvite({
          nome: d.nome,
          origem: cargo.origem,
          destino: cargo.destino,
        });
        const metadata = {
          source: "route_need",
          stage: "invited",
          loadId: cargo.id,
          origem: cargo.origem,
          destino: cargo.destino,
          waveIndex,
        };
        cursorMs += computeDripGapMs(cfg);
        const nextAttemptAt = new Date(cursorMs).toISOString();
        const { rows } = await client
          .query(
            `INSERT INTO public.pending_driver_outreach
               (driver_key, trigger, phone, message, correlation_id, metadata, next_attempt_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (driver_key, trigger) DO NOTHING
             RETURNING id`,
            [key, trigger, d.phone, text, `route-need-${cargo.id}`, JSON.stringify(metadata), nextAttemptAt],
          )
          .catch(() => ({ rows: [] }));
        if (rows[0]) totalEnqueued += 1;
      }
      if (wave.length) cargasTouched += 1;
    }

    return { enqueued: totalEnqueued, cargas: cargasTouched, orphansTotal: allOrphans.length, orphansSkipped };
  });
}
