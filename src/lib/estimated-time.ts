import { addHours, differenceInMinutes, isValid, parseISO } from "date-fns";

const LOADING_PREPARATION_HOURS = 2;
const MINUTES_IN_DAY = 24 * 60;
const MINUTES_IN_HOUR = 60;

function parseDateInput(value: string | Date) {
  const parsedValue = value instanceof Date ? value : parseISO(value);

  if (!isValid(parsedValue)) {
    return null;
  }

  return parsedValue;
}

export function calculateEstimatedTimeInMinutes(
  loadingDate: string | Date,
  unloadingDate: string | Date,
  loadingPreparationHours = LOADING_PREPARATION_HOURS,
) {
  const parsedLoadingDate = parseDateInput(loadingDate);
  const parsedUnloadingDate = parseDateInput(unloadingDate);

  if (!parsedLoadingDate || !parsedUnloadingDate) {
    return null;
  }

  const adjustedLoadingDate = addHours(parsedLoadingDate, loadingPreparationHours);

  return Math.max(
    differenceInMinutes(parsedUnloadingDate, adjustedLoadingDate),
    0,
  );
}

export function formatEstimatedTime(
  loadingDate: string | Date,
  unloadingDate: string | Date,
) {
  const totalMinutes = calculateEstimatedTimeInMinutes(loadingDate, unloadingDate);

  if (totalMinutes === null) {
    return "Indisponivel";
  }

  if (totalMinutes === 0) {
    return "0h";
  }

  const days = Math.floor(totalMinutes / MINUTES_IN_DAY);
  const remainingMinutesAfterDays = totalMinutes % MINUTES_IN_DAY;
  const hours = Math.floor(remainingMinutesAfterDays / MINUTES_IN_HOUR);
  const minutes = remainingMinutesAfterDays % MINUTES_IN_HOUR;
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

  if (parts.length === 0) {
    return `${minutes}min`;
  }

  return parts.join(" ");
}
