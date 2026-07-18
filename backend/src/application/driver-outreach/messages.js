/**
 * driver-outreach — composição das mensagens PT-BR e do link wa.me.
 *
 * Wave A: o operador dispara manualmente abrindo o WhatsApp já preenchido
 * (padrão window.open(whatsappUrl) do painel). Aqui o wa.me aponta para o
 * telefone do MOTORISTA (o operador fala com ele), diferente do fluxo de
 * public-leads onde o link aponta para o número da empresa.
 */

import { OUTREACH_TRIGGERS } from "../../domain/driver-outreach/detection.js";
import { renderMessage } from "./message-templates.js";

const BRAND = "Lamônica Cargas";

function firstName(nome) {
  const first = String(nome || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "motorista";
}

/** Normaliza telefone BR para dígitos com DDI 55. Retorna "" se inválido. */
export function normalizeDriverPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return "";
}

/** Monta o link wa.me para o telefone do motorista com o texto pré-preenchido. */
export function buildDriverWhatsAppUrl(phone, text) {
  const digits = normalizeDriverPhone(phone);
  if (!digits || !text) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * Compõe a mensagem PT-BR de um gatilho. Retorna null quando o gatilho é
 * apenas informativo (ex.: preferences — exibição, sem envio).
 */
export function composeOutreachMessage(trigger, ctx = {}) {
  const nome = firstName(ctx.nome);
  // `force`: sempre retorna texto (usado no wa.me manual do operador). O gate de
  // ligar/desligar é aplicado no enqueue automático (scan-and-enqueue).
  const opts = { force: true };
  switch (trigger) {
    case OUTREACH_TRIGGERS.CHURN: {
      const n = ctx.daysSinceLastLoad;
      const diasTxt = Number.isFinite(n) ? `${n} dias` : "um tempo";
      const openLoad = ctx.openLoad
        ? `Apareceu uma carga que casa com sua rota: ${ctx.openLoad}. `
        : "";
      return renderMessage("churn", { nome, dias: diasTxt, openLoad }, opts);
    }
    case OUTREACH_TRIGGERS.LOST_REGISTRATION:
      return renderMessage("lost_registration", { nome }, opts);
    case OUTREACH_TRIGGERS.ABANDONMENT:
      return renderMessage("abandonment", { nome }, opts);
    case OUTREACH_TRIGGERS.RETURN_LOAD: {
      const s = ctx.suggestion || {};
      const rota =
        s.origem && s.destino
          ? `${s.origem} → ${s.destino}${s.dateIso ? ` (${s.dateIso})` : ""}`
          : `saindo de ${ctx.fromUf || "sua região"}`;
      return renderMessage("return_load", { nome, rota }, opts);
    }
    default:
      return null;
  }
}

/** Mensagem para oferecer uma carga específica que casa com as preferências. */
export function composeSuggestedLoadMessage(nome, load) {
  const rota = `${load.origem} → ${load.destino}${load.dateIso ? ` (${load.dateIso})` : ""}`;
  return renderMessage("suggested_load", { nome: firstName(nome), rota }, { force: true });
}
