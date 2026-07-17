/**
 * driver-outreach — envio automático quando o motorista é RESERVADO em uma
 * carga (lead vira APPROVED / carga vira RESERVED). Chamado DENTRO da transação
 * de approvePublicLoadLead: enfileira em pending_driver_outreach com trigger
 * 'reservation' para o worker de outreach entregar via Evolution.
 *
 * Não lança: falha silenciosa (loga warn). A reserva NÃO deve rolar-back só
 * porque o WhatsApp está fora do ar.
 */

import { normalizeDriverPhone } from "./messages.js";
import { renderMessage, buildCargoDetails, firstName } from "./message-templates.js";

const BRAND = "Lamônica Cargas";

/**
 * Compõe a mensagem de "carga reservada" — texto editável na tela de Mensagens
 * (key `reservation`), com o bloco de detalhes montado pelo sistema.
 */
export function composeReservationMessage({ nome, load }) {
  return renderMessage("reservation", {
    nome: firstName(nome),
    detalhes: buildCargoDetails(load),
  });
}

/**
 * Enfileira o envio de notificação de reserva. Idempotente por
 * (driver_key, trigger) = (cpf, 'reservation-<leadId>') — impede duplicidade
 * se approvePublicLoadLead for chamado 2x (idempotência já protege a reserva,
 * mas defensivo).
 */
export async function enqueueReservationNotification(client, { cpf, nome, phone, leadId, load, correlationId }) {
  try {
    const driverKey = String(cpf || "").replace(/\D/g, "");
    if (driverKey.length !== 11) return { skipped: "no_cpf" };
    const normalizedPhone = normalizeDriverPhone(phone);
    if (!normalizedPhone) return { skipped: "no_phone" };
    const text = composeReservationMessage({ nome, load });
    if (!text) return { skipped: "disabled" }; // mensagem desligada na central
    // Trigger inclui o leadId para permitir múltiplas reservas do mesmo motorista
    // (cada reserva tem sua notificação separada).
    const trigger = `reservation:${leadId}`.slice(0, 64);
    await client.query(
      `INSERT INTO public.pending_driver_outreach
         (driver_key, trigger, phone, message, correlation_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (driver_key, trigger) DO NOTHING`,
      [driverKey, trigger, normalizedPhone, text, correlationId || null],
    );
    return { ok: true };
  } catch (err) {
    // Falha silenciosa: reserva NÃO deve reverter por causa de outreach.
    // eslint-disable-next-line no-console
    console.warn("[reservation-notify] falha ao enfileirar:", err?.message);
    return { skipped: "error", error: err?.message };
  }
}
