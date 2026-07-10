// Shared route normalization utilities used by both service.js and read-models.js

export function buildPaginationMeta(page, pageSize, totalCount, maxPageSize, correlationId) {
  const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);

  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    hasNextPage: page < totalPages,
    maxPageSize,
    correlationId,
  };
}

export function parseNullableNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsedValue = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  return null;
}

export function normalizeRouteLocation(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function stripRouteStateSuffix(value) {
  // Aceita sufixo de UF tanto por barra ("/SP") quanto por hífen ("-SP", " - PE").
  // A planilha Nestlé usa hífen; sem isso "cordeiropolis-sp" nunca reduzia a
  // "cordeiropolis" e não casava com a rota cadastrada ("CORDEIRÓPOLIS/SP").
  return value.replace(/\s*[-/]\s*[a-z]{2}$/i, "").trim();
}

export function stripOperationalLocationSuffix(value) {
  return value
    .replace(/[-_/]\s*\d+\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalizeRouteLookupLocation(value) {
  const normalizedValue = stripOperationalLocationSuffix(stripRouteStateSuffix(normalizeRouteLocation(value)));

  if (!normalizedValue) {
    return "";
  }

  if (/\bsj rio preto\b/.test(normalizedValue) || /\bsao jose do rio preto\b/.test(normalizedValue)) {
    return "sao jose do rio preto";
  }

  if (/\bpedreira\b/.test(normalizedValue)) {
    return "jaguariuna";
  }

  if (/\bsao paulo\b/.test(normalizedValue)) {
    return "sao paulo";
  }

  if (/\bsalvador\b/.test(normalizedValue)) {
    return "salvador";
  }

  if (/\bsimoes filho\b/.test(normalizedValue)) {
    return "simoes filho";
  }

  if (/\bjaboatao dos guararapes\b/.test(normalizedValue) || /\bjaboatao\b/.test(normalizedValue)) {
    return "jaboatao dos guararapes";
  }

  if (/\bfeira de santana\b/.test(normalizedValue)) {
    return "feira de santana";
  }

  if (/\bcampo grande\b/.test(normalizedValue)) {
    return "campo grande";
  }

  if (/\bcamacari\b/.test(normalizedValue)) {
    return "camacari";
  }

  // Aliases de nome divergente entre a planilha do cliente e o cadastro de rota
  // do operador (route_metrics_cache). Sem eles o match cai no fallback e a carga
  // fica sem valor/rota.
  // Cabo de Santo Agostinho — planilha Nestlé abrevia "STO", cadastro usa "SANTO".
  if (/\b(?:sto|santo) agostinho\b/.test(normalizedValue)) {
    return "cabo de santo agostinho";
  }

  // Nossa Senhora do Socorro/SE — cadastro abrevia "Nª SRA. DO SOCORRO".
  if (/\bsocorro\b/.test(normalizedValue)) {
    return "nossa senhora do socorro";
  }

  // São Bernardo do Campo — planilha "DO CAMPO", cadastro "DOS CAMPOS".
  if (/\bsao bernardo d/.test(normalizedValue)) {
    return "sao bernardo do campo";
  }

  // Maceió — a rota do catálogo traz sufixo "/AL - N EIXOS" que sobra no canônico.
  if (/\bmaceio\b/.test(normalizedValue)) {
    return "maceio";
  }

  return normalizedValue;
}

export function createRouteLookupKeys(origin, destination) {
  const originKey = normalizeRouteLocation(origin);
  const destinationKey = normalizeRouteLocation(destination);
  const originWithoutState = stripRouteStateSuffix(originKey);
  const destinationWithoutState = stripRouteStateSuffix(destinationKey);
  const canonicalOrigin = canonicalizeRouteLookupLocation(origin);
  const canonicalDestination = canonicalizeRouteLookupLocation(destination);

  const originVariants = Array.from(
    new Set([originKey, originWithoutState, canonicalOrigin].filter((value) => value !== "")),
  );
  const destinationVariants = Array.from(
    new Set([destinationKey, destinationWithoutState, canonicalDestination].filter((value) => value !== "")),
  );

  return Array.from(
    new Set(
      originVariants.flatMap((originVariant) =>
        destinationVariants.map((destinationVariant) => `${originVariant}|${destinationVariant}`),
      ),
    ),
  );
}
