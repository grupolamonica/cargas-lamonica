// backend/src/domain/operator-admin/aspx-trip-presence.js
//
// Regras puras de "a viagem da carga lançada ainda existe no ASPX/SPX?".
//
// Contexto: uma carga lançada pela Programação (lh_manual = número da viagem "LT…")
// nasce colada a uma viagem do portal SPX. Se a Shopee cancela/remove essa viagem, a
// carga fica órfã: continua aberta no sistema/portal do motorista sem lastro nenhum.
//
// Política (pedido do operador): NUNCA apagar. A carga fica na tela de Cargas com o
// selo "Fora do ASPX", SAI do Monitor (não é mais viagem operável) e o operador é
// avisado — sempre, com re-aviso periódico enquanto a viagem não voltar.

/** Só viagens reais do SPX começam com "LT" (mesmo gate do auto-lançamento/assign).
 *  Nestlé (NESTLE-…), códigos manuais e importações NÃO são cobertos por esta regra. */
export function isSpxTripNumber(lh) {
  return /^LT/i.test(String(lh ?? "").trim());
}

/**
 * Decide o que fazer com uma carga a partir da presença da viagem no índice do SPX.
 *
 *  - "mark"     → sumiu agora (1º ciclo em que falta): marca + avisa
 *  - "renotify" → continua sumida e o último aviso já é antigo: avisa de novo
 *  - "clear"    → voltou a aparecer no ASPX: limpa a marca (volta ao Monitor)
 *  - "none"     → nada a fazer
 *
 * @param {{ present: boolean, missingSince?: Date|string|null,
 *   notifiedAt?: Date|string|null, now?: Date, realertHours?: number }} args
 * @returns {{ action: 'mark'|'renotify'|'clear'|'none' }}
 */
export function classifyAspxPresence({
  present,
  missingSince = null,
  notifiedAt = null,
  now = new Date(),
  realertHours = 6,
} = {}) {
  const marked = missingSince != null && String(missingSince) !== "";

  if (present) return { action: marked ? "clear" : "none" };
  if (!marked) return { action: "mark" };

  // Já marcada: re-avisa quando o último aviso passou da janela. Sem aviso registrado
  // (linha marcada por versão anterior / aviso falhou) → avisa agora.
  const last = notifiedAt ? Date.parse(String(notifiedAt)) : NaN;
  if (!Number.isFinite(last)) return { action: "renotify" };
  const hours = Math.max(0, Number(realertHours) || 0);
  const elapsedMs = now.getTime() - last;
  return elapsedMs >= hours * 3600_000 ? { action: "renotify" } : { action: "none" };
}
