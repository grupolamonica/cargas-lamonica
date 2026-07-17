/**
 * driver-outreach — fluxo de confirmação/expiração de reserva via WhatsApp.
 *
 *   Motorista recebe "Carga reservada para você" → responde no WhatsApp.
 *     - Se responde "sim/aceito/confirmo/…" em ≤ 2h → confirma (BOOKED),
 *       envia agradecimento + oferta de carga de retorno na região do
 *       descarregamento (se houver OPEN casando).
 *     - Se responde "não/recuso/…" → cancela reserva (carga volta OPEN),
 *       notifica operador.
 *     - Se não responde em 2h → carga volta OPEN, notifica operador.
 *
 * Fonte da verdade da reserva: load_public_leads.status=APPROVED + approved_at.
 * Prazo: RESERVATION_ACCEPTANCE_WINDOW_MS = 2h.
 */

import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { normalizeDriverPhone } from "./messages.js";
import { renderMessage, buildCargoDetails } from "./message-templates.js";
import { toIsoDate } from "../../domain/recurrence.js";
import { extractUf } from "../../domain/driver-outreach/detection.js";

export const RESERVATION_ACCEPTANCE_WINDOW_MS = 2 * 60 * 60 * 1000;

// Palavras que confirmam a reserva. Match por regex de palavra inteira / emoji.
const ACCEPT_KEYWORDS = [
  "sim", "aceito", "aceitou", "confirmo", "confirmado", "confirmada",
  "topo", "topei", "topa", "vamos", "quero", "fechado", "fechou", "beleza",
  "blz", "ok", "okay", "positivo", "combinado", "certo", "vou pegar",
];
const REJECT_KEYWORDS = [
  "não", "nao", "recuso", "não quero", "nao quero", "outra carga",
  "não vou", "nao vou", "não posso", "nao posso", "cancela", "desistir",
];
const ACCEPT_EMOJIS = ["👍", "✅", "🤝", "👌"];
const REJECT_EMOJIS = ["👎", "❌", "🚫"];

function normalizeMessageText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** @returns {'accept' | 'reject' | 'unknown'} */
export function parseAcceptanceIntent(text) {
  const raw = String(text || "");
  const norm = normalizeMessageText(raw);
  if (!norm) return "unknown";

  for (const e of REJECT_EMOJIS) if (raw.includes(e)) return "reject";
  for (const e of ACCEPT_EMOJIS) if (raw.includes(e)) return "accept";

  // Rejeição vence empate (ex.: "não aceito" → reject).
  for (const kw of REJECT_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm)) return "reject";
  }
  for (const kw of ACCEPT_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm)) return "accept";
  }
  return "unknown";
}

// ── Persistência de eventos ──────────────────────────────────────────────────

async function insertNotification(client, { kind, title, body, metadata = {} }) {
  await client.query(
    `INSERT INTO public.operator_notifications (kind, title, body, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [kind, title, body || "", JSON.stringify(metadata || {})],
  );
}

/**
 * Busca a reserva PENDENTE de um motorista (por CPF ou telefone).
 * "Pendente" = status APPROVED e ainda dentro da janela de 2h.
 */
export async function findPendingReservation(client, { cpf, phone }) {
  const cpfDigits = String(cpf || "").replace(/\D/g, "");
  const p = normalizeDriverPhone(phone);
  const cutoff = new Date(Date.now() - RESERVATION_ACCEPTANCE_WINDOW_MS).toISOString();
  const baseSelect = `
    SELECT l.id AS lead_id, l.load_id, l.cpf, l.phone, l.approved_at,
           c.origem, c.destino, c.data, c.horario, c.perfil, c.valor, c.bonus,
           c.status AS load_status
      FROM public.load_public_leads l
      JOIN public.cargas c ON c.id = l.load_id
     WHERE l.status = 'APPROVED'
       AND c.status = 'RESERVED'
       AND l.approved_at IS NOT NULL
       AND l.approved_at > $1
  `;
  try {
    // 1) Tenta por CPF (mais preciso).
    if (cpfDigits) {
      const r = await client.query(
        `${baseSelect} AND l.cpf = $2 ORDER BY l.approved_at DESC LIMIT 1`,
        [cutoff, cpfDigits],
      );
      if (r.rows[0]) return r.rows[0];
    }
    // 2) Fallback por telefone (aceita com/sem DDI).
    if (p) {
      const withoutDdi = p.startsWith("55") && p.length >= 12 ? p.slice(2) : p;
      const r = await client.query(
        `${baseSelect} AND (l.phone = $2 OR l.phone = $3) ORDER BY l.approved_at DESC LIMIT 1`,
        [cutoff, p, withoutDdi],
      );
      if (r.rows[0]) return r.rows[0];
    }
    return null;
  } catch {
    return null;
  }
}

// ── Confirmação (BOOKED) ─────────────────────────────────────────────────────

/**
 * Confirma a reserva: carga vai OPEN/RESERVED → BOOKED. Cria notificação para
 * o operador. Retorna o lead+carga confirmados ou null se nada mudou.
 */
export async function confirmReservation(client, { leadId, correlationId }) {
  const { rows: leadRows } = await client.query(
    `SELECT l.id AS lead_id, l.load_id, l.cpf, l.phone, c.origem, c.destino, c.data, c.horario
       FROM public.load_public_leads l
       JOIN public.cargas c ON c.id = l.load_id
      WHERE l.id = $1 AND l.status = 'APPROVED' AND c.status = 'RESERVED'`,
    [leadId],
  );
  const lead = leadRows[0];
  if (!lead) return null;

  await client.query(
    `UPDATE public.cargas
        SET status = 'BOOKED', booked_at = now(), updated_at = now(), version = version + 1
      WHERE id = $1 AND status = 'RESERVED'`,
    [lead.load_id],
  );

  await insertNotification(client, {
    kind: "driver_reply_accept",
    title: "Motorista aceitou a carga",
    body: `${lead.origem || ""} → ${lead.destino || ""}`,
    metadata: {
      lead_id: lead.lead_id,
      load_id: lead.load_id,
      cpf: lead.cpf,
      phone: lead.phone,
      correlation_id: correlationId || null,
    },
  });

  return lead;
}

// ── Rejeição / expiração (volta OPEN) ────────────────────────────────────────

async function reopenLoadAndCancelLead(client, { leadId, loadId, reason, correlationId }) {
  await client.query(
    `UPDATE public.load_public_leads
        SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1`,
    [leadId],
  );
  await client.query(
    `UPDATE public.cargas
        SET status = 'OPEN', reserved_at = null, reserved_until = null,
            reserved_driver_id = null, reserved_claim_id = null,
            reserved_public_lead_id = null, updated_at = now(),
            version = version + 1
      WHERE id = $1 AND status IN ('RESERVED', 'BOOKED')`,
    [loadId],
  );
  await insertNotification(client, {
    kind: reason === "timeout" ? "reservation_timeout" : "driver_reply_reject",
    title: reason === "timeout" ? "Reserva expirou (2h sem resposta)" : "Motorista recusou a carga",
    body: reason === "timeout"
      ? "A carga voltou automaticamente para a fila (OPEN)."
      : "A carga voltou para a fila (OPEN).",
    metadata: {
      lead_id: leadId,
      load_id: loadId,
      reason,
      correlation_id: correlationId || null,
    },
  });
}

// ── Mensagens de resposta (agradecimento / oferta de retorno / feedback) ─────

function firstName(nome) {
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

export function composeThankYouMessage({ nome, load, returnLoad }) {
  let retorno = "";
  if (returnLoad) {
    retorno =
      `\n\n👉 E olha só, já tem uma pra volta: ${returnLoad.origem} → ${returnLoad.destino}` +
      `${returnLoad.dateIso ? ` (${fmtDateBR(returnLoad.dateIso)})` : ""}` +
      `${returnLoad.valor ? ` — ${fmtBRL(returnLoad.valor)}` : ""}. Quer emendar? É só responder *SIM*.`;
  }
  return renderMessage("reservation_thankyou", {
    nome: firstName(nome),
    detalhes: buildCargoDetails(load),
    retorno,
  });
}

/** Busca uma carga OPEN saindo da UF do destino da carga confirmada. */
export async function findReturnLoadForDriver(client, { fromUf, loadIdToExclude, todayIso }) {
  if (!fromUf) return null;
  const { rows } = await client.query(
    `SELECT id, origem, destino, data, horario, perfil, valor
       FROM public.cargas
      WHERE status = 'OPEN' AND id <> $1
      ORDER BY data ASC NULLS LAST`,
    [loadIdToExclude || "00000000-0000-0000-0000-000000000000"],
  );
  for (const r of rows) {
    if (extractUf(r.origem) !== fromUf) continue;
    const dateIso = r.data ? toIsoDate(r.data) : null;
    if (dateIso && todayIso && String(dateIso) < String(todayIso)) continue;
    return {
      id: r.id,
      origem: r.origem,
      destino: r.destino,
      dateIso,
      horario: r.horario,
      perfil: r.perfil,
      valor: r.valor,
    };
  }
  return null;
}

// ── Job: expiração automática de reservas ────────────────────────────────────

/**
 * Reverte reservas com > 2h sem confirmação. Idempotente. Cria notificação para
 * o operador em cada reserva expirada. Retorna { expired: n }.
 */
export async function expireStaleReservations({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RESERVATION_ACCEPTANCE_WINDOW_MS).toISOString();
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT l.id AS lead_id, l.load_id
         FROM public.load_public_leads l
         JOIN public.cargas c ON c.id = l.load_id
        WHERE l.status = 'APPROVED'
          AND c.status = 'RESERVED'
          AND l.approved_at IS NOT NULL
          AND l.approved_at <= $1
        LIMIT 200`,
      [cutoff],
    );
    for (const r of rows) {
      await reopenLoadAndCancelLead(client, {
        leadId: r.lead_id,
        loadId: r.load_id,
        reason: "timeout",
      });
    }
    return { expired: rows.length };
  });
}

// ── Entrada pública para reprocessar quando mensagem entra ───────────────────

/**
 * Ao receber uma mensagem IN de um motorista, verifica se ele tem reserva
 * pendente e reage à intenção (accept/reject). Retorna o resultado.
 *
 * @param {object} args
 * @param {string} args.phone      — telefone (dígitos)
 * @param {string} args.text       — texto da mensagem
 * @param {string} [args.driverKey] — CPF resolvido (opcional)
 * @param {string} [args.correlationId]
 * @returns {Promise<{intent: string, action: 'confirmed'|'rejected'|'no_reservation'|'ignored', lead?: object}>}
 */
export async function handleDriverReplyForReservation({ phone, text, driverKey, correlationId }) {
  const intent = parseAcceptanceIntent(text);
  if (intent === "unknown") return { intent, action: "ignored" };

  return withPgTransaction(async (client) => {
    const reservation = await findPendingReservation(client, {
      cpf: driverKey || "",
      phone,
    });
    if (!reservation) return { intent, action: "no_reservation" };

    if (intent === "accept") {
      const lead = await confirmReservation(client, {
        leadId: reservation.lead_id,
        correlationId,
      });
      return { intent, action: "confirmed", lead };
    }
    // reject
    await reopenLoadAndCancelLead(client, {
      leadId: reservation.lead_id,
      loadId: reservation.load_id,
      reason: "rejected",
      correlationId,
    });
    return { intent, action: "rejected", lead: reservation };
  });
}
