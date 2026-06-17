/**
 * Relogio "de parede" no fuso oficial da operacao (America/Sao_Paulo),
 * independente do timezone do processo.
 *
 * Por que isto existe: o container do backend roda em UTC (docker-compose nao
 * seta TZ), enquanto `cargas.data` (DATE) e `cargas.horario` (TIME) sao gravados
 * em horario LOCAL do Brasil. Toda comparacao "esta carga ja passou?" precisa do
 * relogio de Sao Paulo. Usar `new Date().toISOString()` (data em UTC) combinado
 * com `new Date().toTimeString()` (hora no TZ do processo) mistura fusos e
 * esconde cargas de hoje ate ~3h cedo — e o dia inteiro depois das 21h BRT,
 * quando a data UTC ja virou "amanha".
 */

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

// en-CA formata data como YYYY-MM-DD; hourCycle h23 garante hora 00-23.
const saoPauloPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SAO_PAULO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Data e hora correntes (ou de um instante dado) no fuso America/Sao_Paulo.
 *
 * @param {Date} [now] instante de referencia (default: agora).
 * @returns {{ dateIso: string, timeIso: string }} dateIso no formato
 *   "YYYY-MM-DD" e timeIso no formato "HH:MM:SS", ambos em horario de Sao Paulo.
 */
export function getSaoPauloWallClock(now = new Date()) {
  const parts = {};
  for (const part of saoPauloPartsFormatter.formatToParts(now)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    dateIso: `${parts.year}-${parts.month}-${parts.day}`,
    timeIso: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
