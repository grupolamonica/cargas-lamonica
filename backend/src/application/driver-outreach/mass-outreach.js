/**
 * driver-outreach — envio em MASSA (broadcast) para múltiplos motoristas.
 *
 * Público-alvo:
 *   - "all": todos os motoristas cadastrados (motoristas_historico) com telefone
 *   - "routes": motoristas que já carregaram/candidataram alguma das rotas
 *     escolhidas (planilha snapshot + load_public_leads JOIN cargas)
 *
 * Enfileira em pending_driver_outreach com trigger `mass:<batchId>` — idempotente
 * por (driver_key, trigger). O worker existente entrega respeitando cap diário,
 * quiet hours, opt-out e circuit breaker (é OUTREACH, não transacional).
 *
 * Placeholder na mensagem:
 *   {nome} — primeiro nome do motorista (fallback: "motorista")
 *   {rota} — origem → destino (quando aplicável, senão vazio)
 */

import crypto from "node:crypto";
import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { ValidationError } from "../../domain/load-claims/errors.js";
import { normalizeText } from "../../domain/driver-outreach/detection.js";
import { toIsoDate } from "../../domain/recurrence.js";
import { normalizeDriverPhone } from "./messages.js";
import { lookupAngelliraDriverByCpf, lookupAngelliraPlate } from "../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../infrastructure/aspx/aspx-directory.js";
import { getOutreachConfig, computeDripGapMs } from "./config.js";
import { renderMessage, buildCargoDetails } from "./message-templates.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

const MAX_AUDIENCE = 5000;

function normalizeCpf(v) {
  return String(v || "").replace(/\D/g, "");
}

function firstName(nome) {
  const f = String(nome || "").trim().split(/\s+/)[0] || "";
  return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : "motorista";
}

/** Aplica placeholders {nome} e {rota} no template da mensagem. */
export function renderTemplate(template, { nome, rota } = {}) {
  const withVars = String(template || "")
    .replaceAll("{nome}", firstName(nome))
    .replaceAll("{rota}", rota || "");
  // Spintax: expande grupos {opção A|opção B|opção C} escolhendo uma variante
  // por destinatário. Assim a mesma campanha não envia texto idêntico para
  // centenas de números (sinal clássico de spam/bot no WhatsApp).
  return spin(withVars);
}

/**
 * Expande spintax: cada `{a|b|c}` vira uma das opções, escolhida aleatoriamente.
 * Só toca em grupos que contêm `|` — placeholders como {nome} já foram resolvidos
 * antes e não têm pipe, então passam intactos. Suporta 1 nível (sem aninhamento).
 */
export function spin(text) {
  return String(text || "").replace(/\{([^{}]*\|[^{}]*)\}/g, (_, group) => {
    const opts = group.split("|");
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

// ── Rotas disponíveis (histórico) ────────────────────────────────────────────

/**
 * Lista rotas com contagem de motoristas distintos que carregaram/candidataram.
 * Une snapshot da planilha (motoristas por nome) + cargas com candidaturas
 * (motoristas por CPF via load_public_leads).
 */
export async function listMassOutreachRoutes({ limit = 200 } = {}) {
  return withPgClient(async (client) => {
    // Da planilha: rotas (origem→destino) com nomes de motoristas.
    let sheetRotas = new Map(); // key -> { origem, destino, drivers:Set<nomeNorm> }
    try {
      const { rows } = await client.query(
        `SELECT rows_json FROM public.sheet_monitor_snapshot WHERE id = 1`,
      );
      const arr = Array.isArray(rows[0]?.rows_json) ? rows[0].rows_json : [];
      for (const r of arr) {
        const origem = String(r?.origem || "").trim();
        const destino = String(r?.destino || "").trim();
        const nome = String(r?.motoristas || "").trim();
        if (!origem || !destino || !nome) continue;
        const key = `${origem}→${destino}`;
        if (!sheetRotas.has(key)) sheetRotas.set(key, { origem, destino, drivers: new Set() });
        sheetRotas.get(key).drivers.add(normalizeText(nome));
      }
    } catch {
      // no snapshot yet — ok
    }

    // De cargas + candidaturas: CPFs dos motoristas que se candidataram.
    let leadRotas = new Map(); // key -> { origem, destino, cpfs:Set<string> }
    try {
      const { rows } = await client.query(
        `SELECT c.origem, c.destino, l.cpf
           FROM public.load_public_leads l
           JOIN public.cargas c ON c.id = l.load_id
          WHERE l.cpf IS NOT NULL AND coalesce(c.origem,'') <> '' AND coalesce(c.destino,'') <> ''`,
      );
      for (const r of rows) {
        const key = `${r.origem}→${r.destino}`;
        if (!leadRotas.has(key)) leadRotas.set(key, { origem: r.origem, destino: r.destino, cpfs: new Set() });
        leadRotas.get(key).cpfs.add(normalizeCpf(r.cpf));
      }
    } catch {
      // ok
    }

    const merged = new Map();
    for (const [k, v] of sheetRotas) {
      merged.set(k, { origem: v.origem, destino: v.destino, driverCount: v.drivers.size });
    }
    for (const [k, v] of leadRotas) {
      const cur = merged.get(k);
      if (cur) cur.driverCount += v.cpfs.size;
      else merged.set(k, { origem: v.origem, destino: v.destino, driverCount: v.cpfs.size });
    }

    const list = [...merged.entries()]
      .map(([key, v]) => ({ key, origem: v.origem, destino: v.destino, driverCount: v.driverCount }))
      .filter((r) => r.driverCount > 0)
      .sort((a, b) => b.driverCount - a.driverCount || a.key.localeCompare(b.key))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
    return { items: list };
  });
}

// ── Público-alvo (resolução de motoristas) ────────────────────────────────────

/**
 * Resolve o público-alvo — retorna array de {cpf?, nome?, phone, rota?}.
 * Dedup por telefone normalizado (DDI 55). Ignora motoristas sem telefone.
 * `MAX_AUDIENCE` é o teto de segurança.
 */
export async function resolveMassAudience(client, { audience, routes } = {}) {
  const out = new Map(); // phone -> {cpf, nome, phone, rota}

  const addFromHistoric = async (extraFilter, params, rota) => {
    const q = `SELECT cpf, nome, telefone FROM public.motoristas_historico
                WHERE telefone IS NOT NULL AND telefone <> ''
                  ${extraFilter}`;
    const { rows } = await client.query(q, params).catch(() => ({ rows: [] }));
    for (const r of rows) {
      const phone = normalizeDriverPhone(r.telefone);
      if (!phone || out.size >= MAX_AUDIENCE) continue;
      if (!out.has(phone)) {
        out.set(phone, { cpf: r.cpf || null, nome: r.nome || null, phone, rota: rota || null });
      }
    }
  };

  if (audience === "all") {
    await addFromHistoric("", [], null);
    return [...out.values()];
  }

  if (audience === "routes" && Array.isArray(routes) && routes.length) {
    for (const key of routes) {
      const [origem, destino] = String(key || "").split("→").map((s) => s.trim());
      if (!origem || !destino) continue;
      const rota = `${origem} → ${destino}`;

      // 1) Nomes distintos que apareceram na planilha para essa rota.
      const names = new Set();
      try {
        const { rows } = await client.query(
          `SELECT rows_json FROM public.sheet_monitor_snapshot WHERE id = 1`,
        );
        const arr = Array.isArray(rows[0]?.rows_json) ? rows[0].rows_json : [];
        for (const r of arr) {
          if (String(r?.origem || "").trim() === origem && String(r?.destino || "").trim() === destino) {
            const nm = String(r?.motoristas || "").trim();
            if (nm) names.add(nm);
          }
        }
      } catch {
        // ignore
      }
      if (names.size) {
        const uppers = [...names].map((n) => n.toUpperCase());
        const ph = uppers.map((_, i) => `$${i + 1}`).join(",");
        await addFromHistoric(`AND UPPER(nome) IN (${ph})`, uppers, rota);
      }

      // 2) CPFs que se candidataram a essa rota (cargas.origem/destino).
      try {
        const { rows } = await client.query(
          `SELECT DISTINCT l.cpf
             FROM public.load_public_leads l
             JOIN public.cargas c ON c.id = l.load_id
            WHERE c.origem = $1 AND c.destino = $2 AND l.cpf IS NOT NULL`,
          [origem, destino],
        );
        const cpfs = rows.map((r) => normalizeCpf(r.cpf)).filter((c) => c.length === 11);
        if (cpfs.length) {
          const ph = cpfs.map((_, i) => `$${i + 1}`).join(",");
          await addFromHistoric(`AND cpf IN (${ph})`, cpfs, rota);
        }
      } catch {
        // ignore
      }
    }
    return [...out.values()];
  }

  return [];
}

/** Preview: conta público + amostra de 5 motoristas para o operador conferir. */
export async function previewMassAudience({ audience, routes } = {}) {
  return withPgClient(async (client) => {
    const list = await resolveMassAudience(client, { audience, routes });
    return {
      total: list.length,
      capped: list.length >= MAX_AUDIENCE,
      sample: list.slice(0, 5).map((d) => ({
        nome: d.nome,
        cpf: d.cpf,
        phone: `**${String(d.phone || "").slice(-4)}`,
        rota: d.rota,
      })),
    };
  });
}

/**
 * Enfileira envios em massa. Cria um `batchId` (UUID) e faz INSERT em
 * pending_driver_outreach com trigger `mass:<batchId>`. Idempotente por
 * (driver_key, trigger) — nunca duplica na mesma batch.
 */
export async function enqueueMassOutreach({ audience, routes, message } = {}) {
  const template = String(message || "").trim();
  if (!template) throw new ValidationError("Escreva a mensagem antes de disparar.");
  if (audience !== "all" && audience !== "routes") {
    throw new ValidationError("Selecione o público-alvo.");
  }
  if (audience === "routes" && (!Array.isArray(routes) || routes.length === 0)) {
    throw new ValidationError("Selecione ao menos uma rota.");
  }
  const batchId = crypto.randomUUID();
  const trigger = `mass:${batchId}`.slice(0, 64);

  return withPgClient(async (client) => {
    const audienceList = await resolveMassAudience(client, { audience, routes });
    if (!audienceList.length) return { batchId, enqueued: 0, total: 0 };

    const cfg = await getOutreachConfig(client);

    // ── DRIP SCHEDULING (anti-ban) ─────────────────────────────────────────
    // Em vez de deixar TODAS as linhas elegíveis de imediato (o worker
    // dispararia em rajada), escalonamos next_attempt_at com um intervalo
    // humano e aleatório entre cada envio. Começamos ATRÁS de qualquer backlog
    // já agendado, para que uma nova campanha não colida com outra em curso.
    const { rows: maxRows } = await client
      .query(
        `SELECT GREATEST(now(), COALESCE(max(next_attempt_at), now())) AS base
           FROM public.pending_driver_outreach
          WHERE status = 'pending'`,
      )
      .catch(() => ({ rows: [{ base: new Date() }] }));
    let cursorMs = new Date(maxRows[0]?.base || Date.now()).getTime();

    let enqueued = 0;
    for (const d of audienceList) {
      const driverKey = normalizeCpf(d.cpf) || normalizeText(d.nome);
      if (!driverKey) continue;
      const text = renderTemplate(template, { nome: d.nome, rota: d.rota || "" }).slice(0, 2000);
      // Metadata guarda o contexto do envio — usado pelo follow-up quando o
      // motorista responde "aceito" (busca carga OPEN casando com essa rota).
      const [origem, destino] = String(d.rota || "").split("→").map((s) => s.trim());
      const metadata = {
        audience,
        rota: d.rota || null,
        origem: origem || null,
        destino: destino || null,
        batchId,
      };
      // Cada motorista recebe uma janela própria (drip): 1º sai logo, os demais
      // vão escalonando com jitter. Ainda passam pelos gates do worker (cap
      // diário/horário, quiet hours, opt-out).
      cursorMs += computeDripGapMs(cfg);
      const nextAttemptAt = new Date(cursorMs).toISOString();
      const { rows } = await client
        .query(
          `INSERT INTO public.pending_driver_outreach
             (driver_key, trigger, phone, message, correlation_id, metadata, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (driver_key, trigger) DO NOTHING
           RETURNING id`,
          [driverKey, trigger, d.phone, text, `mass-${batchId}`, JSON.stringify(metadata), nextAttemptAt],
        )
        .catch(() => ({ rows: [] }));
      if (rows[0]) enqueued += 1;
    }

    const etaMinutes = Math.round((cursorMs - Date.now()) / 60000);
    return { batchId, enqueued, total: audienceList.length, etaMinutes };
  });
}

// ── Follow-up: motorista aceitou o convite em massa ─────────────────────────

function firstNameHelper(nome) {
  const f = String(nome || "").trim().split(/\s+/)[0] || "";
  return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : "motorista";
}
function fmtBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtDateBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * Compõe a resposta com detalhes de UMA carga aberta na rota do envio em massa.
 */
export function composeMassFollowUpMessage({ nome, load }) {
  return renderMessage("mass_followup", {
    nome: firstNameHelper(nome),
    detalhes: buildCargoDetails(load),
  });
}

/**
 * Compõe a resposta quando o motorista aceita mas NÃO há carga aberta na rota.
 */
export function composeMassNoLoadMessage({ nome, rota }) {
  return renderMessage("mass_no_load", {
    nome: firstNameHelper(nome),
    rota: rota || "essa rota",
  });
}

/**
 * Busca o envio em massa mais recente (últimas 24h) do motorista e retorna a
 * carga OPEN (futura) que casa com a rota + o metadata. Retorna null se não
 * houver contexto de massa ou carga disponível.
 */
export async function findMassContextAndLoad(client, { phone, driverKey }) {
  const p = String(phone || "").replace(/\D/g, "");
  const cpfDigits = String(driverKey || "").replace(/\D/g, "");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1) Recupera envio em massa recente por driver_key OU pelo próprio telefone.
  //    (dedup: pega o mais recente entre ambos)
  let row = null;
  if (cpfDigits) {
    const r = await client
      .query(
        `SELECT id, metadata, message, created_at
           FROM public.pending_driver_outreach
          WHERE driver_key = $1 AND trigger LIKE 'mass:%' AND created_at > $2
          ORDER BY created_at DESC LIMIT 1`,
        [cpfDigits, cutoff],
      )
      .catch(() => ({ rows: [] }));
    row = r.rows[0] || null;
  }
  if (!row && p) {
    const r = await client
      .query(
        `SELECT id, metadata, message, created_at
           FROM public.pending_driver_outreach
          WHERE phone = $1 AND trigger LIKE 'mass:%' AND created_at > $2
          ORDER BY created_at DESC LIMIT 1`,
        [p, cutoff],
      )
      .catch(() => ({ rows: [] }));
    row = r.rows[0] || null;
  }
  if (!row) return null;

  const meta = row.metadata || {};
  const rota = meta.rota || null;

  // 2) Se veio de "por rota", tenta achar carga OPEN casando (futura).
  const today = new Date().toISOString().slice(0, 10);
  let load = null;
  if (meta.origem && meta.destino) {
    const { rows } = await client
      .query(
        `SELECT id, origem, destino, data, horario, perfil, eixos, valor, bonus
           FROM public.cargas
          WHERE status = 'OPEN' AND origem = $1 AND destino = $2
          ORDER BY data ASC NULLS LAST
          LIMIT 20`,
        [meta.origem, meta.destino],
      )
      .catch(() => ({ rows: [] }));
    for (const r of rows) {
      const dateIso = r.data ? toIsoDate(r.data) : null;
      if (dateIso && String(dateIso) < today) continue;
      load = {
        id: r.id,
        origem: r.origem,
        destino: r.destino,
        dateIso,
        horario: r.horario,
        perfil: r.perfil,
        eixos: r.eixos,
        valor: r.valor,
        bonus: r.bonus,
      };
      break;
    }
  }

  return { rota, meta, load, pendingId: row.id };
}

// ── Fluxo pós-detalhes: motorista confirma a candidatura ─────────────────────

/**
 * Ao entregar composeMassFollowUpMessage, marcamos no metadata que aquele envio
 * já ofertou a carga X. Assim, quando o motorista responder SIM depois, sabemos
 * que se trata da confirmação e criamos a candidatura em load_public_leads.
 */
export async function markDetailedOfferSent(client, { pendingId, loadId }) {
  if (!pendingId || !loadId) return;
  await client
    .query(
      `UPDATE public.pending_driver_outreach
          SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{detailedOffer}',
                                   $2::jsonb, true)
        WHERE id = $1`,
      [pendingId, JSON.stringify({ loadId, sentAt: new Date().toISOString() })],
    )
    .catch(() => {});
}

/**
 * Busca o envio em massa com detailedOffer aguardando confirmação (últimas 4h).
 * Retorna { pending_id, load_id, driver_key, phone, alreadyConverted } ou null.
 */
export async function findAwaitingCandidatura(client, { phone, driverKey }) {
  const p = String(phone || "").replace(/\D/g, "");
  const cpfDigits = String(driverKey || "").replace(/\D/g, "");
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const baseWhere =
    "trigger LIKE 'mass:%' AND metadata ? 'detailedOffer' " +
    "AND (metadata->'detailedOffer'->>'sentAt')::timestamptz > $1::timestamptz " +
    "AND coalesce(metadata->>'candidaturaCreatedFor','') = ''";
  if (cpfDigits) {
    const r = await client
      .query(
        `SELECT id, driver_key, phone, metadata
           FROM public.pending_driver_outreach
          WHERE ${baseWhere} AND driver_key = $2
          ORDER BY (metadata->'detailedOffer'->>'sentAt')::timestamptz DESC LIMIT 1`,
        [cutoff, cpfDigits],
      )
      .catch(() => ({ rows: [] }));
    if (r.rows[0]) return r.rows[0];
  }
  if (p) {
    const r = await client
      .query(
        `SELECT id, driver_key, phone, metadata
           FROM public.pending_driver_outreach
          WHERE ${baseWhere} AND phone = $2
          ORDER BY (metadata->'detailedOffer'->>'sentAt')::timestamptz DESC LIMIT 1`,
        [cutoff, p],
      )
      .catch(() => ({ rows: [] }));
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

const VALID_VEHICLE_TYPES = new Set(["TRUCK", "CARRETA", "CARRETA_EXPRESSA", "BITREM"]);

/**
 * Cria uma candidatura em load_public_leads reutilizando os últimos dados do
 * motorista (última entrada por CPF ou por telefone). Retorna a linha criada
 * (ou existente, se já havia uma ativa para essa carga).
 */
export async function createLeadFromMassAccept(client, { loadId, cpf, phone }) {
  const cpfDigits = String(cpf || "").replace(/\D/g, "");
  const p = String(phone || "").replace(/\D/g, "");

  // Se já tem lead ATIVA para essa carga, retorna ela.
  const existing = await client
    .query(
      `SELECT id, status FROM public.load_public_leads
        WHERE load_id = $1 AND (cpf = $2 OR phone = $3)
          AND status IN ('PRE_REGISTERED','QUEUED','APPROVED')
        ORDER BY created_at DESC LIMIT 1`,
      [loadId, cpfDigits, p],
    )
    .catch(() => ({ rows: [] }));
  if (existing.rows[0]) return { lead: existing.rows[0], duplicate: true };

  // Últimos dados do próprio motorista (por CPF, senão por telefone).
  let last = null;
  if (cpfDigits) {
    const r = await client
      .query(
        `SELECT horse_plate, trailer_plate, trailer_plate_2, vehicle_type, phone
           FROM public.load_public_leads
          WHERE cpf = $1 AND coalesce(horse_plate,'') <> ''
          ORDER BY created_at DESC LIMIT 1`,
        [cpfDigits],
      )
      .catch(() => ({ rows: [] }));
    last = r.rows[0] || null;
  }
  if (!last && p) {
    const r = await client
      .query(
        `SELECT horse_plate, trailer_plate, trailer_plate_2, vehicle_type, phone, cpf
           FROM public.load_public_leads
          WHERE phone = $1 AND coalesce(horse_plate,'') <> ''
          ORDER BY created_at DESC LIMIT 1`,
        [p],
      )
      .catch(() => ({ rows: [] }));
    last = r.rows[0] || null;
  }

  const horse = last?.horse_plate || "";
  const trailer = last?.trailer_plate || "";
  const trailer2 = last?.trailer_plate_2 || "";
  const vType = VALID_VEHICLE_TYPES.has(String(last?.vehicle_type || "")) ? last.vehicle_type : "CARRETA";

  const { rows } = await client
    .query(
      `INSERT INTO public.load_public_leads
         (load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2, vehicle_type,
          status, pre_registered_at, queued_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'QUEUED', now(), now(), now(), now())
       RETURNING id, status`,
      [loadId, cpfDigits || (last?.cpf ?? ""), p || last?.phone || "", horse, trailer, trailer2, vType],
    );
  return { lead: rows[0], duplicate: false };
}

/**
 * Consulta Angellira (motorista + placas) e ASPX (motorista) em paralelo.
 * Retorna resumo com booleanos: `angellira.vigente`, `aspx.found`, placas vigentes.
 */
export async function validateDriverAgainstExternal(client, { cpf, horsePlate, trailerPlate }) {
  const cpfDigits = String(cpf || "").replace(/\D/g, "");
  const opts = { sourceEvent: "mass-outreach.candidatura" };
  const today = getSaoPauloWallClock().dateIso;

  const [angDriver, angHorse, angTrailer, aspx] = await Promise.allSettled([
    cpfDigits.length === 11 ? lookupAngelliraDriverByCpf(cpfDigits, opts) : Promise.resolve(null),
    horsePlate ? lookupAngelliraPlate(horsePlate, opts) : Promise.resolve(null),
    trailerPlate ? lookupAngelliraPlate(trailerPlate, opts) : Promise.resolve(null),
    cpfDigits.length === 11 ? lookupAspxDriverByCpf(client, cpfDigits) : Promise.resolve(null),
  ]);

  const pickVigente = (r) => {
    if (r.status !== "fulfilled" || !r.value) return { checked: false, vigente: false };
    const v = r.value;
    const vigente = v.status === "FOUND" && Boolean(v.validUntil) && String(v.validUntil) >= today;
    return {
      checked: true,
      status: v.status || null,
      found: Boolean(v.found),
      validUntil: v.validUntil ?? null,
      vigente,
      name: v.displayName ?? null,
    };
  };

  return {
    angellira: {
      motorista: pickVigente(angDriver),
      cavalo: pickVigente(angHorse),
      carreta: pickVigente(angTrailer),
    },
    aspx: {
      found: aspx.status === "fulfilled" && Boolean(aspx.value?.found),
      displayName:
        aspx.status === "fulfilled" && aspx.value?.found ? (aspx.value?.displayName ?? null) : null,
    },
  };
}

/**
 * Verifica se o motorista tem cadastro PENDENTE (não finalizado):
 *   - Não está vigente no Angellira, E
 *   - Não tem registro concluído em pending_driver_registrations
 *     (status IN 'pendente'|'draft'|'rascunho' OU sem registro nenhum).
 * Retorna { pending: bool, reason: 'no_angellira'|'no_registration'|'draft'|'pendente'|null }.
 */
export async function checkRegistrationPending(client, { cpf, angelliraVigente }) {
  const cpfDigits = String(cpf || "").replace(/\D/g, "");
  if (!cpfDigits) return { pending: false, reason: null };
  // Se está vigente no Angellira, considera "concluído".
  if (angelliraVigente) return { pending: false, reason: null };
  try {
    const { rows } = await client.query(
      `SELECT status FROM public.pending_driver_registrations
        WHERE dados->'motorista'->>'cpf' = $1
        ORDER BY created_at DESC LIMIT 1`,
      [cpfDigits],
    );
    if (!rows.length) return { pending: true, reason: "no_registration" };
    const st = String(rows[0].status || "").toLowerCase();
    if (["concluido", "aprovado", "migrado_bot"].includes(st)) {
      return { pending: false, reason: null };
    }
    return { pending: true, reason: st || "pendente" };
  } catch {
    return { pending: false, reason: null };
  }
}

/** Marca a linha de mass como já convertida em candidatura (idempotência). */
export async function markMassConvertedToCandidatura(client, { pendingId, leadId }) {
  if (!pendingId || !leadId) return;
  await client
    .query(
      `UPDATE public.pending_driver_outreach
          SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb),
                                   '{candidaturaCreatedFor}', to_jsonb($2::text), true)
        WHERE id = $1`,
      [pendingId, String(leadId)],
    )
    .catch(() => {});
}

function publicAppUrl() {
  return String(process.env.PUBLIC_APP_URL || "https://cargas.grupolamonica.com").replace(/\/$/, "");
}

/**
 * Mensagem de confirmação da candidatura com o link do portal.
 * Se `registrationPending`, adiciona bloco convidando o motorista a completar
 * o cadastro no portal.
 */
export function composeMassCandidaturaConfirmMessage({
  nome,
  load,
  duplicate,
  registrationPending,
  reason,
}) {
  const cargoUrl = `${publicAppUrl()}/motorista/cargas/${load.id}`;
  const portalUrl = `${publicAppUrl()}/motorista`;
  let avisoCadastro = "";
  if (registrationPending) {
    avisoCadastro =
      "\n\n" +
      (reason === "no_registration"
        ? "⚠️ Só um detalhe: você ainda não tem cadastro com a gente."
        : "⚠️ Só um detalhe: seu cadastro tá quase pronto, faltam alguns documentos.") +
      `\nTermina rapidinho aqui: ${portalUrl}`;
  }
  return renderMessage("mass_candidatura_confirm", {
    nome: firstNameHelper(nome),
    detalhes: buildCargoDetails(load),
    link: cargoUrl,
    aviso_cadastro: avisoCadastro,
  });
}


