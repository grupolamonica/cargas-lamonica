import { addHours, differenceInMinutes, format, isValid, parse, parseISO } from "date-fns";

const SHEET_DATETIME_PATTERN = "dd/MM/yyyy HH:mm";
const MINUTES_IN_HOUR = 60;
const MINUTES_IN_DAY = 24 * MINUTES_IN_HOUR;
const LOADING_OFFSET_HOURS = 2;

type DateInput = string | Date | null | undefined;

function parseDateInput(value: DateInput) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return isValid(value) ? value : null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const isoDate = parseISO(trimmedValue);
  if (isValid(isoDate)) {
    return isoDate;
  }

  const sheetDate = parse(trimmedValue, SHEET_DATETIME_PATTERN, new Date());
  if (isValid(sheetDate)) {
    return sheetDate;
  }

  const nativeDate = new Date(trimmedValue);
  return isValid(nativeDate) ? nativeDate : null;
}

function normalizeDateOnlyValue(value: string) {
  const trimmedValue = value.trim();
  const matchedDate = trimmedValue.match(/^(\d{4}-\d{2}-\d{2})/);

  if (matchedDate?.[1]) {
    return matchedDate[1];
  }

  return trimmedValue;
}

export function buildLoadingDateTime(
  loadingLabel?: string | null,
  date?: string | null,
  time?: string | null,
) {
  const parsedLoadingLabel = parseDateInput(loadingLabel);
  if (parsedLoadingLabel) {
    return parsedLoadingLabel;
  }

  if (!date || !time) {
    return null;
  }

  const normalizedDate = normalizeDateOnlyValue(date);
  const normalizedTime = time.slice(0, 5);
  const parsedFallback = parseDateInput(`${normalizedDate}T${normalizedTime}`);
  return parsedFallback;
}

export function buildOperationalDateLabel(
  primaryLabel?: string | null,
  fallbackDate?: string | null,
  fallbackTime?: string | null,
) {
  const parsedPrimaryDate = parseDateInput(primaryLabel);
  if (parsedPrimaryDate) {
    return format(parsedPrimaryDate, "dd/MM/yyyy HH:mm");
  }

  const fallbackDateTime = buildLoadingDateTime(null, fallbackDate, fallbackTime);
  if (fallbackDateTime) {
    return format(fallbackDateTime, "dd/MM/yyyy HH:mm");
  }

  return "A confirmar";
}

export function calculateEstimatedTimeInMinutes(
  loadingDate: DateInput,
  unloadingDate: DateInput,
  loadingOffsetHours = LOADING_OFFSET_HOURS,
) {
  const parsedLoadingDate = parseDateInput(loadingDate);
  const parsedUnloadingDate = parseDateInput(unloadingDate);

  if (!parsedLoadingDate || !parsedUnloadingDate) {
    return null;
  }

  const adjustedLoadingDate = addHours(parsedLoadingDate, loadingOffsetHours);
  const adjustedWindowMinutes = differenceInMinutes(parsedUnloadingDate, adjustedLoadingDate);

  if (adjustedWindowMinutes > 0) {
    return adjustedWindowMinutes;
  }

  const directWindowMinutes = differenceInMinutes(parsedUnloadingDate, parsedLoadingDate);

  return Math.max(directWindowMinutes, 0);
}

export function formatEstimatedTime(
  loadingDate: DateInput,
  unloadingDate: DateInput,
) {
  const totalMinutes = calculateEstimatedTimeInMinutes(loadingDate, unloadingDate);

  if (totalMinutes === null) {
    return "A confirmar";
  }

  if (totalMinutes === 0) {
    return "0min";
  }

  const days = Math.floor(totalMinutes / MINUTES_IN_DAY);
  const remainingMinutes = totalMinutes % MINUTES_IN_DAY;
  const hours = Math.floor(remainingMinutes / MINUTES_IN_HOUR);
  const minutes = remainingMinutes % MINUTES_IN_HOUR;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 && parts.length < 2) {
    parts.push(`${minutes}min`);
  }

  return parts.join(" ");
}

function formatFallbackDurationHours(durationHours: number) {
  const formattedHours = formatDurationHours(durationHours);

  return `Tempo estimado: ~${formattedHours}`;
}

function formatExactDurationHours(durationHours: number) {
  const formattedHours = formatDurationHours(durationHours);

  return `Tempo estimado: ${formattedHours}`;
}

function formatDurationHours(durationHours: number) {
  const totalMinutes = Math.max(Math.round(durationHours * MINUTES_IN_HOUR), 0);
  const hours = Math.floor(totalMinutes / MINUTES_IN_HOUR);
  const minutes = totalMinutes % MINUTES_IN_HOUR;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}min`);
  }

  if (parts.length === 0) {
    return "0min";
  }

  return parts.join(" ");
}

interface BuildEstimatedDurationLabelInput {
  loadingLabel?: string | null;
  unloadingLabel?: string | null;
  fallbackDurationHours?: number | null;
  fallbackDate?: string | null;
  fallbackTime?: string | null;
}

export function buildEstimatedDurationLabel({
  loadingLabel,
  unloadingLabel,
  fallbackDurationHours,
  fallbackDate,
  fallbackTime,
}: BuildEstimatedDurationLabelInput) {
  const loadingDate = buildLoadingDateTime(loadingLabel, fallbackDate, fallbackTime);
  const estimatedWindow = formatEstimatedTime(loadingDate, unloadingLabel);

  if (estimatedWindow !== "A confirmar") {
    return `Tempo estimado: ${estimatedWindow}`;
  }

  if (typeof fallbackDurationHours === "number" && Number.isFinite(fallbackDurationHours)) {
    return formatFallbackDurationHours(fallbackDurationHours);
  }

  return undefined;
}

interface BuildRouteEstimatedDurationLabelInput {
  routeEstimatedHours?: number | null;
  fallbackDurationHours?: number | null;
}

export function buildRouteEstimatedDurationLabel({
  routeEstimatedHours,
  fallbackDurationHours,
}: BuildRouteEstimatedDurationLabelInput) {
  if (typeof routeEstimatedHours === "number" && Number.isFinite(routeEstimatedHours)) {
    return formatExactDurationHours(routeEstimatedHours);
  }

  if (typeof fallbackDurationHours === "number" && Number.isFinite(fallbackDurationHours)) {
    return formatFallbackDurationHours(fallbackDurationHours);
  }

  return undefined;
}
