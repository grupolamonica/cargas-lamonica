import { addHours, differenceInMinutes, isValid, parse, parseISO } from "date-fns";

const SHEET_DATETIME_PATTERN = "dd/MM/yyyy HH:mm";
const DEFAULT_LOADING_OFFSET_HOURS = 2;

function parseDateInput(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return isValid(value) ? value : null;
  }

  const trimmedValue = String(value).trim();
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

export function calculateOperationalEtaMinutes(
  loadingDate,
  unloadingDate,
  loadingOffsetHours = DEFAULT_LOADING_OFFSET_HOURS,
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

export function calculateOperationalEtaHours(
  loadingDate,
  unloadingDate,
  loadingOffsetHours = DEFAULT_LOADING_OFFSET_HOURS,
) {
  const totalMinutes = calculateOperationalEtaMinutes(loadingDate, unloadingDate, loadingOffsetHours);

  if (totalMinutes === null) {
    return null;
  }

  return Math.round(((totalMinutes / 60) + Number.EPSILON) * 100) / 100;
}
