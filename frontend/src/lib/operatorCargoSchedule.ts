const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY_PATTERN = /^\d{2}:\d{2}(?::\d{2})?$/;

export function normalizeOperatorCargoDate(value: string | null | undefined, fallback = "") {
  const trimmedValue = String(value || "").trim();

  if (!trimmedValue) {
    return fallback;
  }

  if (DATE_ONLY_PATTERN.test(trimmedValue)) {
    return trimmedValue;
  }

  const isoLikeMatch = trimmedValue.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);

  if (isoLikeMatch?.[1]) {
    return isoLikeMatch[1];
  }

  return fallback;
}

export function normalizeOperatorCargoTime(value: string | null | undefined, fallback = "") {
  const trimmedValue = String(value || "").trim();

  if (!trimmedValue) {
    return fallback;
  }

  if (TIME_ONLY_PATTERN.test(trimmedValue)) {
    return trimmedValue.slice(0, 5);
  }

  const isoLikeMatch = trimmedValue.match(/[T\s](\d{2}:\d{2})(?::\d{2})?/);

  if (isoLikeMatch?.[1]) {
    return isoLikeMatch[1];
  }

  return fallback;
}
