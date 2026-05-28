import { format, isValid, parse, parseISO } from "date-fns";

const DATETIME_PATTERNS = ["dd/MM/yyyy HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd HH:mm:ss"] as const;
const PLACEHOLDER_VALUES = new Set(["null", "undefined", "invalid date", "nan"]);

export type DateDisplayInput = string | Date | null | undefined;

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
  const parsedDate = parseDisplayDate(value);
  return parsedDate ? format(parsedDate, "dd/MM/yyyy") : fallback;
}

/**
 * Parse a date-only string (e.g. "2025-12-31") as local time noon,
 * preventing UTC-negative timezone display as the previous day.
 */
export function parseDateStringAsLocal(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  return new Date(dateStr + "T12:00:00");
}

