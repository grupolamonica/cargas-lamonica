const MINUTES_IN_HOUR = 60;

function coerceFiniteNumber(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const normalizedValue = value.replace(/\./g, "").replace(",", ".").trim();
    const parsedValue = Number.parseFloat(normalizedValue);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

export function normalizeRouteLocation(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function trimTextOrNull(value?: string | null) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

export function parseOptionalNumber(value?: string | null) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  const normalizedValue = trimmedValue.replace(",", ".");
  const parsedValue = Number.parseFloat(normalizedValue);

  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function parseMoneyInput(value?: string | null) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  const cleanedValue = trimmedValue.replace(/[^\d,.-]/g, "");
  const hasComma = cleanedValue.includes(",");
  const hasDot = cleanedValue.includes(".");

  let normalizedValue = cleanedValue;

  if (hasComma && hasDot) {
    normalizedValue =
      cleanedValue.lastIndexOf(",") > cleanedValue.lastIndexOf(".")
        ? cleanedValue.replace(/\./g, "").replace(",", ".")
        : cleanedValue.replace(/,/g, "");
  } else if (hasComma) {
    normalizedValue = cleanedValue.replace(/\./g, "").replace(",", ".");
  } else {
    normalizedValue = cleanedValue.replace(/,/g, "");
  }

  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export function formatRouteCurrency(value: number | string | null, fallback = "A combinar") {
  const parsedValue = coerceFiniteNumber(value);

  if (parsedValue === null) {
    return fallback;
  }

  return parsedValue.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function formatRouteMetric(value: number | string | null, unit: string, prefix = "") {
  const parsedValue = coerceFiniteNumber(value);

  if (parsedValue === null) {
    return "A confirmar";
  }

  return `${prefix}${parsedValue.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(parsedValue) ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${unit}`;
}

export function formatRouteDurationHours(value: number | string | null) {
  const parsedValue = coerceFiniteNumber(value);

  if (parsedValue === null) {
    return "A confirmar";
  }

  const totalMinutes = Math.max(Math.round(parsedValue * MINUTES_IN_HOUR), 0);

  if (totalMinutes === 0) {
    return "0h";
  }

  const hours = Math.floor(totalMinutes / MINUTES_IN_HOUR);
  const minutes = totalMinutes % MINUTES_IN_HOUR;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}min`);
  }

  return parts.join(" ");
}
