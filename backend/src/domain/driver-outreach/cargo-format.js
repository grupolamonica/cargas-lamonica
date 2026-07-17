/**
 * cargo-format — formatação compartilhada de detalhes de carga nas mensagens
 * de WhatsApp (driver-outreach). Mantém perfil+eixos e o aviso do bônus
 * consistentes em TODAS as mensagens.
 */

/**
 * Perfil do veículo no mesmo formato do portal /motorista: "CARRETA · 6 eixos".
 * Sem eixos (0/nulo) → só o perfil. Sem perfil → "".
 */
export function formatVehicleProfile(perfil, eixos) {
  if (!perfil) return "";
  const n = Number(eixos);
  return Number.isFinite(n) && n > 0 ? `${perfil} · ${n} eixos` : String(perfil);
}

/**
 * Aviso obrigatório sempre que o bônus é exibido: o bônus depende de cumprir as
 * normas da empresa e ter pontualidade.
 */
export const BONUS_DISCLAIMER =
  "_⚠️ O bônus é pago só cumprindo as normas da empresa e com pontualidade._";
