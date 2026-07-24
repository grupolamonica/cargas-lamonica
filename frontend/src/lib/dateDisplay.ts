import { format, isValid, parse, parseISO } from "date-fns";

const DATETIME_PATTERNS = ["dd/MM/yyyy HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd HH:mm:ss"] as const;
const PLACEHOLDER_VALUES = new Set(["null", "undefined", "invalid date", "nan"]);

export type DateDisplayInput = string | Date | null | undefined;

// Data (YYYY-MM-DD) no fuso de São Paulo, opcionalmente deslocada por `offsetDays`.
// Necessário porque `cargas.data` é wall-clock BRT e new Date().toISOString() (UTC)
// vira D+1 após ~21h BRT — o que fazia filtros de "hoje" errarem à noite.
const SAO_PAULO_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function saoPauloDateIso(offsetDays = 0): string {
  const instant = new Date(Date.now() + offsetDays * 86_400_000);
  return SAO_PAULO_YMD.format(instant); // en-CA → "YYYY-MM-DD"
}

export function parseDisplayDate(value: DateDisplayInput) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return isValid(value) ? value : null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue || PLACEHOLDER_VALUES.has(trimmedValue.toLowerCase())) {
    return null;
  }

  const isoDate = parseISO(trimmedValue);
  if (isValid(isoDate)) {
    return isoDate;
  }

  for (const pattern of DATETIME_PATTERNS) {
    const parsedDate = parse(trimmedValue, pattern, new Date());
    if (isValid(parsedDate)) {
      return parsedDate;
    }
  }

  const nativeDate = new Date(trimmedValue);
  return isValid(nativeDate) ? nativeDate : null;
}

function normalizeTimeValue(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue || PLACEHOLDER_VALUES.has(trimmedValue.toLowerCase())) {
    return null;
  }

  const matchedTime = trimmedValue.match(/^(\d{1,2}):(\d{2})/);
  if (!matchedTime) {
    return null;
  }

  return `${matchedTime[1].padStart(2, "0")}:${matchedTime[2]}`;
}

export function buildDisplayDateTime(date?: string | null, time?: string | null) {
  const normalizedDate = typeof date === "string" ? date.trim() : "";
  const normalizedTime = typeof time === "string" ? normalizeTimeValue(time) : null;

  if (!normalizedDate || PLACEHOLDER_VALUES.has(normalizedDate.toLowerCase()) || !normalizedTime) {
    return null;
  }

  const separator = normalizedDate.includes("/") ? " " : "T";
  return parseDisplayDate(`${normalizedDate}${separator}${normalizedTime}`);
}

export function formatShortDateTime(value: DateDisplayInput, fallback = "Aguardando") {
  const parsedDate = parseDisplayDate(value);
  return parsedDate ? format(parsedDate, "dd/MM HH:mm") : fallback;
}

export function formatFullDateTime(value: DateDisplayInput, fallback = "Aguardando") {
  const parsedDate = parseDisplayDate(value);
  return parsedDate ? format(parsedDate, "dd/MM/yyyy HH:mm") : fallback;
}

export function formatDateOnly(value: DateDisplayInput, fallback = "A confirmar") {
  // Datas de calendário (coluna `date` do Postgres, ex. `cargas.data`) chegam
  // serializadas como "YYYY-MM-DDT00:00:00.000Z" porque o container do backend
  // roda em UTC. Interpretá-las como instante (parseISO) e formatar no fuso do
  // navegador (BRT, UTC-3) empurra a exibição para o DIA ANTERIOR (ex.: a data
  // 2026-06-22 aparece como 21/06). Para um rótulo "somente data" o que importa
  // é a data de calendário escrita no valor — reformatamos o prefixo YYYY-MM-DD
  // diretamente, sem passar por instante/fuso.
  if (typeof value === "string") {
    const calendarDate = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (calendarDate) {
      const [, year, month, day] = calendarDate;
      return `${day}/${month}/${year}`;
    }
  }

  const parsedDate = parseDisplayDate(value);
  return parsedDate ? format(parsedDate, "dd/MM/yyyy") : fallback;
}

/**
 * Rótulo de agenda (Coleta/Entrega) exibido em cargas/monitor.
 *
 * Cargas de planilha guardam um rótulo já amigável em sheet_data_* (ex.
 * "11/07 08:00") — devolvemos inalterado. Cargas adicionadas manualmente guardam
 * o valor cru do <input type="datetime-local"> ("2026-07-11T12:00"); nesse caso
 * formatamos os componentes direto para "DD-MM-AAAA HH:mm", SEM converter para
 * instante/fuso (o valor é a hora de parede escolhida pelo operador — parseISO +
 * fuso deslocaria a hora).
 */
export function formatScheduleLabel(value: DateDisplayInput, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue || PLACEHOLDER_VALUES.has(trimmedValue.toLowerCase())) {
    return fallback;
  }

  // ISO datetime-local ("YYYY-MM-DDTHH:mm" ou "YYYY-MM-DD HH:mm") → formata direto.
  const isoLocal = trimmedValue.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (isoLocal) {
    const [, year, month, day, hour, minute] = isoLocal;
    return `${day}-${month}-${year} ${hour}:${minute}`;
  }

  // Já é um rótulo amigável (planilha) — devolve como está.
  return trimmedValue;
}

/**
 * Parse a date-only string (e.g. "2025-12-31") as local time noon,
 * preventing UTC-negative timezone display as the previous day.
 */
export function parseDateStringAsLocal(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00");
}

