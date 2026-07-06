/**
 * Rótulo denormalizado de carregamento (`cargas.sheet_data_carregamento`) das
 * cargas do SISTEMA (sheet_lh nulo). Esse campo é lido por várias telas
 * (painel de Cargas do operador, Overview, detalhe do motorista — algumas
 * direto do Supabase) e é PREFERIDO sobre `data`/`horário` no display. Se ele
 * não acompanhar as colunas canônicas quando elas mudam (auto-avanço da
 * recorrência, edição no Monitor, clone-on-reserve), o operador/motorista vê a
 * agenda velha.
 *
 * Esta camada de domínio define O rótulo canônico a partir de data+horário, no
 * mesmo formato datetime-local ("YYYY-MM-DDTHH:MM") que o painel de Cargas grava,
 * para o campo denormalizado nunca divergir.
 */

import { toIsoDate } from "./recurrence.js";

/**
 * @param {Date|string} data     DATE ('YYYY-MM-DD' ou Date UTC-midnight do pg)
 * @param {Date|string} horario  TIME ('HH:MM[:SS]' string do pg)
 * @returns {string|null} 'YYYY-MM-DDTHH:MM' ou null se a data for inválida
 */
export function systemCarregamentoLabel(data, horario) {
  const d = toIsoDate(data);
  if (!d || d.length < 10) return null;
  const hhmm = String(horario ?? "").slice(0, 5);
  return `${d}T${hhmm || "00:00"}`;
}

/**
 * Rótulo de carregamento SINCRONIZADO para uma carga do sistema, preservando o
 * estado "sem rótulo": se `current` é null, mantém null (cargas criadas pelo
 * Monitor não têm o campo e caem no fallback data+horário no front); se está
 * preenchido, devolve o rótulo canônico derivado de data+horário.
 *
 * @param {string|null|undefined} current  valor atual de sheet_data_carregamento
 * @param {Date|string} data
 * @param {Date|string} horario
 * @returns {string|null}
 */
export function syncedCarregamentoLabel(current, data, horario) {
  if (current == null) return null;
  return systemCarregamentoLabel(data, horario);
}
