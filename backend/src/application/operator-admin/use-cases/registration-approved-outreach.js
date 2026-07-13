// DC-198 — Notificação de WhatsApp ao motorista quando o cadastro é APROVADO.
//
// ESTADO: lógica pronta, porém DESLIGADA por padrão (flag). O envio real depende de:
//   (a) a fundação `driver-outreach` (fila `pending_driver_outreach` + adapter de
//       canal + opt-out + guardrails) — branch `feat/driver-outreach-foundation`,
//       ainda não mergeada; e
//   (b) a decisão da DC-176 (migrar o canal para o WhatsApp Cloud API oficial).
//
// Enquanto isso, o seam `notifyRegistrationApproved` NÃO envia nada — só decide e
// devolve a mensagem pronta. Quando a fundação/Cloud API chegarem, conectar o seam:
// enfileirar em `pending_driver_outreach` com trigger `registration_approved`
// (respeitando opt-out + guardrails), no lugar do retorno `pending_channel`.
//
// Este módulo é PURO (sem imports/efeitos) → testável e sem risco de load.

const FEATURE_FLAG = "DRIVER_OUTREACH_REGISTRATION_APPROVED_ENABLED";

/** Flag off por padrão. Aceita "true"/"1". */
export function isRegistrationApprovedOutreachEnabled(env = process.env) {
  const v = String(env?.[FEATURE_FLAG] ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Template (pt-BR) da mensagem de cadastro aprovado. Genérico (sem cliente).
 * @param {{nome?: string}} args
 * @returns {string}
 */
export function buildRegistrationApprovedMessage({ nome } = {}) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "motorista";
  return (
    `Olá, ${primeiro}! 🎉\n\n` +
    `Seu cadastro no *Grupo Lamônica* foi aprovado — você já está apto a carregar com a gente.\n\n` +
    `Fique de olho nas cargas disponíveis pelo nosso portal. Boas viagens! 🚚`
  );
}

/**
 * Seam de notificação (DC-198). PURO e best-effort — nunca lança.
 * Decide se deve notificar e devolve a mensagem pronta; NÃO envia (canal pendente).
 *
 * REGRA (pedido do operador): só notifica quando o cadastro está TODO CONFORME no
 * Angellira E no SPX (`allConforme === true`) — só avisamos "você está apto a
 * carregar" quem de fato está apto. A conformidade vem do precheck (Angellira
 * motorista/cavalo/carreta vigentes + SPX vigente/na nossa agência).
 *
 * @param {{nome?:string, telefone?:string, allConforme?:boolean}} args
 * @returns {{sent:boolean, reason:"feature_disabled"|"nao_conforme"|"no_phone"|"pending_channel", message?:string, recipientPhone?:string}}
 */
export function notifyRegistrationApproved({ nome, telefone, allConforme } = {}, { env = process.env } = {}) {
  if (!isRegistrationApprovedOutreachEnabled(env)) {
    return { sent: false, reason: "feature_disabled" };
  }
  if (allConforme !== true) {
    // Não conforme (ou conformidade desconhecida) → não avisa "apto".
    return { sent: false, reason: "nao_conforme" };
  }
  const phone = String(telefone ?? "").replace(/\D/g, "");
  if (phone.length < 10) {
    return { sent: false, reason: "no_phone" };
  }
  // SEAM: canal real ainda não conectado. Quando a fundação driver-outreach +
  // Cloud API (DC-176) chegarem, trocar por enfileirar em pending_driver_outreach
  // (trigger 'registration_approved') respeitando opt-out/guardrails.
  return {
    sent: false,
    reason: "pending_channel",
    message: buildRegistrationApprovedMessage({ nome }),
    recipientPhone: phone,
  };
}
