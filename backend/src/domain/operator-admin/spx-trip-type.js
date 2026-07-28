// backend/src/domain/operator-admin/spx-trip-type.js
//
// Classifica o TIPO da viagem SPX/Shopee a partir do NOME da viagem (LH Trip Name).
// O feed do portal (Torre /api/spx/asp) NÃO traz o tipo em coluna própria — ele vem
// embutido no nome, logo após o prefixo de data (AAAAMMDD). Determinado a partir dos
// tipos que já passaram no sistema (DC-279), amostrando os 3 tabs do SPX:
//
//   "20260802F0_125_4199_21:00_22:00_HUB_AM01"  → forecast  (naming F<slot>_… : F0_/F1_/…)
//   "20260728Adhoc-S0217519HAM0501"             → adhoc     (spot / ad-hoc)
//   "20260731FM Hub_3PL_SP_Pedreira_01-2601"    → fm-hub    (lane 3PL de FM Hub)
//   qualquer outro / vazio                       → outros
//
// Só "forecast" dispara o ALARME SONORO do operador na Programação — os demais tipos
// continuam aparecendo no sino (visual), mas sem som.

const DATE_PREFIX = /^\s*\d{8}\s*/; // AAAAMMDD no início do nome

/** Remove o prefixo de data (AAAAMMDD) do nome da viagem. */
function stripDatePrefix(name) {
  return String(name ?? "").replace(DATE_PREFIX, "");
}

/**
 * @param {string} tripName nome da viagem (LH Trip Name)
 * @returns {"forecast"|"adhoc"|"fm-hub"|"outros"}
 */
export function classifySpxTripType(tripName) {
  const rest = stripDatePrefix(tripName);
  if (!rest) return "outros";
  if (/adhoc/i.test(rest)) return "adhoc";
  // Forecast = "F" seguido de dígito (F0_, F1_, …). Precisa vir ANTES de fm-hub
  // porque ambos começam com "F"; fm-hub é "FM " (F + letra), não casa aqui.
  if (/^F\d/i.test(rest)) return "forecast";
  if (/^FM\b/i.test(rest)) return "fm-hub";
  return "outros";
}

/** true quando a viagem é do tipo Forecast (naming F<slot>). */
export function isForecastTripName(tripName) {
  return classifySpxTripType(tripName) === "forecast";
}
