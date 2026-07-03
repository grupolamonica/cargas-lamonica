import { normalizeRouteLocation } from "@/lib/routeCatalog";
import { normalizeVehicleProfile } from "@/lib/vehicleProfiles";
import { fetchOperatorRoutes } from "@/services/readModels";

export interface AssignableRouteOption {
  id: string;
  route_key: string;
  origin_key: string;
  destination_key: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  tempo_estimado_horas: number | null;
  perfil_padrao: string | null;
  eixos?: number | null;
  valor_padrao: number | null;
  bonus_padrao: number | null;
  ativa: boolean;
  base_route_label: string | null;
  source: "base" | "base+db" | "db";
}

export interface CargoRouteAssignmentDraft {
  route_key?: string;
  origem: string;
  destino: string;
  perfil: string;
  eixos?: number | null;
  valor?: string;
  bonus?: string;
}

interface CargoPaymentDraft {
  valor: number | null;
  bonus: number | null;
}

type CargoPaymentSource = "cargo" | "route" | "mixed" | "none";

function toFiniteNumber(value: unknown) {
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

function hasFiniteNumber(value: unknown): value is number {
  return toFiniteNumber(value) !== null;
}

export function buildAssignableRouteKey(origin: string, destination: string) {
  return `${normalizeRouteLocation(origin)}|${normalizeRouteLocation(destination)}`;
}

function stripRouteStateSuffix(value: string) {
  return value.replace(/\s*\/\s*[a-z]{2}$/i, "").trim();
}

function stripOperationalLocationSuffix(value: string) {
  return value
    .replace(/[-_/]\s*\d+\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeRouteLookupLocation(value: string) {
  const normalizedValue = stripOperationalLocationSuffix(stripRouteStateSuffix(normalizeRouteLocation(value)));

  if (!normalizedValue) {
    return "";
  }

  if (/\bsj rio preto\b/.test(normalizedValue) || /\bsao jose do rio preto\b/.test(normalizedValue)) {
    return "sao jose do rio preto";
  }

  if (/\bpedreira\b/.test(normalizedValue) || /\bsao paulo\b/.test(normalizedValue)) {
    return "sao paulo";
  }

  if (/\bsalvador\b/.test(normalizedValue)) {
    return "salvador";
  }

  if (/\bsimoes filho\b/.test(normalizedValue)) {
    return "simoes filho";
  }

  if (/\bjaboatao dos guararapes\b/.test(normalizedValue)) {
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

  return normalizedValue;
}

export function createRouteLookupKeys(origin: string, destination: string) {
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

export async function fetchAssignableRoutes() {
  const response = await fetchOperatorRoutes({
    page: "1",
    pageSize: "200",
    status: "todas",
  });

  return response.items;
}

export function getAssignableRouteLabel(route: Pick<AssignableRouteOption, "base_route_label" | "origem" | "destino">) {
  return route.base_route_label || `${route.origem} -> ${route.destino}`;
}

export function findAssignableRouteByLocations(
  routes: AssignableRouteOption[],
  origin: string,
  destination: string,
) {
  const routeLookupKeys = new Set(createRouteLookupKeys(origin, destination));

  return (
    routes.find((route) => {
      return createRouteLookupKeys(route.origem, route.destino).some((routeKey) => routeLookupKeys.has(routeKey));
    }) || null
  );
}

// Uma rota por veículo: dado o trecho + perfil + eixos da carga, acha a rota
// daquele veículo. Prefere perfil+eixos exatos; depois o mesmo perfil; por fim
// uma rota genérica do trecho (perfil não definido) como fonte de preço.
// NUNCA devolve uma rota de OUTRO perfil — não force preço de veículo errado.
export function findAssignableRouteByVehicle(
  routes: AssignableRouteOption[],
  origin: string,
  destination: string,
  perfil: string,
  eixos: number | null | undefined,
) {
  const routeLookupKeys = new Set(createRouteLookupKeys(origin, destination));
  const locationMatches = routes.filter((route) =>
    createRouteLookupKeys(route.origem, route.destino).some((routeKey) => routeLookupKeys.has(routeKey)),
  );

  if (locationMatches.length === 0) {
    return null;
  }

  const normalizedPerfil = normalizeVehicleProfile(perfil || "CARRETA");
  const targetEixos = eixos ?? 0;
  const sameProfile = locationMatches.filter(
    (route) => route.perfil_padrao && normalizeVehicleProfile(route.perfil_padrao) === normalizedPerfil,
  );

  if (sameProfile.length > 0) {
    return sameProfile.find((route) => (route.eixos ?? 0) === targetEixos) || sameProfile[0];
  }

  return locationMatches.find((route) => !route.perfil_padrao) || null;
}

export function resolveAssignableRouteForCargo(
  routes: AssignableRouteOption[],
  cargo: Pick<CargoRouteAssignmentDraft, "route_key" | "origem" | "destino">,
) {
  if (cargo.route_key) {
    const routeFromKey = routes.find((route) => route.route_key === cargo.route_key);

    if (routeFromKey) {
      return routeFromKey;
    }
  }

  return findAssignableRouteByLocations(routes, cargo.origem, cargo.destino);
}

export function applyAssignableRouteToCargoDraft<T extends CargoRouteAssignmentDraft>(
  cargo: T,
  route: AssignableRouteOption | null,
) {
  if (!route) {
    return cargo;
  }

  const nextPerfil = normalizeVehicleProfile(route.perfil_padrao || cargo.perfil || "CARRETA");
  // Rota do catálogo é por veículo: ao selecioná-la, herda o nº de eixos dela.
  // Rota genérica (eixos 0/nulo) preserva o que o operador já tinha.
  const nextEixos = route.eixos ?? cargo.eixos ?? 0;
  const nextValor = route.valor_padrao !== null ? String(route.valor_padrao) : cargo.valor || "";
  const nextBonus = route.bonus_padrao !== null ? String(route.bonus_padrao) : cargo.bonus || "";
  const hasChanges =
    cargo.route_key !== route.route_key ||
    cargo.perfil !== nextPerfil ||
    (cargo.eixos ?? 0) !== nextEixos ||
    (route.valor_padrao !== null && cargo.valor !== nextValor) ||
    (route.bonus_padrao !== null && cargo.bonus !== nextBonus);

  if (!hasChanges) {
    return cargo;
  }

  return {
    ...cargo,
    route_key: route.route_key,
    perfil: nextPerfil,
    eixos: nextEixos,
    valor: nextValor,
    bonus: nextBonus,
  };
}

// Auto-match (operador digitou origem/destino e escolheu o veículo): preenche
// só valor/bônus da rota daquele veículo, SEM sobrescrever o perfil/eixos que o
// operador definiu.
export function applyRouteVehiclePricingToCargoDraft<T extends CargoRouteAssignmentDraft>(
  cargo: T,
  route: AssignableRouteOption | null,
) {
  if (!route) {
    return cargo;
  }

  const nextValor = route.valor_padrao !== null ? String(route.valor_padrao) : cargo.valor || "";
  const nextBonus = route.bonus_padrao !== null ? String(route.bonus_padrao) : cargo.bonus || "";
  const hasChanges =
    cargo.route_key !== route.route_key ||
    (route.valor_padrao !== null && cargo.valor !== nextValor) ||
    (route.bonus_padrao !== null && cargo.bonus !== nextBonus);

  if (!hasChanges) {
    return cargo;
  }

  return {
    ...cargo,
    route_key: route.route_key,
    valor: nextValor,
    bonus: nextBonus,
  };
}

export function buildCargoTotalPayment(valor: number | null, bonus: number | null) {
  const parsedValor = toFiniteNumber(valor);
  const parsedBonus = toFiniteNumber(bonus);
  const hasValor = parsedValor !== null;
  const hasBonus = parsedBonus !== null;

  if (!hasValor && !hasBonus) {
    return null;
  }

  return (hasValor ? parsedValor : 0) + (hasBonus ? parsedBonus : 0);
}

export function resolveCargoCompensation(
  cargo: CargoPaymentDraft,
  route: Pick<AssignableRouteOption, "valor_padrao" | "bonus_padrao"> | null,
) {
  const cargoValor = toFiniteNumber(cargo.valor);
  const cargoBonus = toFiniteNumber(cargo.bonus);
  const routeValor = toFiniteNumber(route?.valor_padrao);
  const routeBonus = toFiniteNumber(route?.bonus_padrao);
  const hasCargoValor = cargoValor !== null;
  const hasCargoBonus = cargoBonus !== null;
  const hasRouteValor = routeValor !== null;
  const hasRouteBonus = routeBonus !== null;

  const valor = hasCargoValor ? cargoValor : hasRouteValor ? routeValor : null;
  const bonus = hasCargoBonus ? cargoBonus : hasRouteBonus ? routeBonus : null;
  const usedRouteFallback = (!hasCargoValor && hasRouteValor) || (!hasCargoBonus && hasRouteBonus);
  const usedCargoValues = hasCargoValor || hasCargoBonus;

  let source: CargoPaymentSource = "none";
  if (usedCargoValues && usedRouteFallback) {
    source = "mixed";
  } else if (usedRouteFallback) {
    source = "route";
  } else if (usedCargoValues) {
    source = "cargo";
  }

  return {
    valor,
    bonus,
    total: buildCargoTotalPayment(valor, bonus),
    source,
  };
}
