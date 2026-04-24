import { resolveCargoCompensation, type AssignableRouteOption } from "@/lib/assignableRoutes";

export type CargoPublicationMissingField = "profile" | "payment" | "distance" | "estimatedTime";

interface CargoPublicationCandidate {
  perfil?: string | null;
  valor?: number | null;
  bonus?: number | null;
  distancia_km?: number | null;
  duracao_horas?: number | null;
  tempo_estimado_horas?: number | null;
}

type CargoPublicationRouteFallback = Pick<
  AssignableRouteOption,
  "perfil_padrao" | "valor_padrao" | "bonus_padrao" | "distancia_km" | "duracao_horas" | "tempo_estimado_horas"
> | null;

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

function normalizeOptionalText(value?: string | null) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : null;
}

function buildAlertSummary(missingFields: CargoPublicationMissingField[]) {
  if (missingFields.length === 0) {
    return null;
  }

  const labels = missingFields.map((field) => {
    switch (field) {
      case "profile":
        return "perfil do veiculo";
      case "payment":
        return "frete";
      case "distance":
        return "distancia da rota";
      case "estimatedTime":
        return "tempo estimado";
      default:
        return field;
    }
  });

  const summary =
    labels.length > 1
      ? `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`
      : labels[0];

  return `Faltam ${summary}.`;
}

export function resolveCargoPublicationReadiness(
  cargo: CargoPublicationCandidate,
  route: CargoPublicationRouteFallback,
) {
  const payment = resolveCargoCompensation(
    {
      valor: toFiniteNumber(cargo.valor),
      bonus: toFiniteNumber(cargo.bonus),
    },
    route
      ? {
          valor_padrao: route.valor_padrao,
          bonus_padrao: route.bonus_padrao,
        }
      : null,
  );

  const perfil = normalizeOptionalText(cargo.perfil) ?? normalizeOptionalText(route?.perfil_padrao) ?? null;
  const distanciaKm = toFiniteNumber(cargo.distancia_km) ?? toFiniteNumber(route?.distancia_km);
  const duracaoHoras = toFiniteNumber(cargo.duracao_horas) ?? toFiniteNumber(route?.duracao_horas);
  const tempoEstimadoHoras =
    toFiniteNumber(cargo.tempo_estimado_horas) ?? toFiniteNumber(route?.tempo_estimado_horas) ?? duracaoHoras;

  const missingFields: CargoPublicationMissingField[] = [];

  if (!perfil) {
    missingFields.push("profile");
  }

  if (payment.valor === null) {
    missingFields.push("payment");
  }

  if (distanciaKm === null) {
    missingFields.push("distance");
  }

  if (tempoEstimadoHoras === null) {
    missingFields.push("estimatedTime");
  }

  return {
    isReady: missingFields.length === 0,
    missingFields,
    alertSummary: buildAlertSummary(missingFields),
    perfil,
    valor: payment.valor,
    bonus: payment.bonus,
    totalPayment: payment.total,
    compensationSource: payment.source,
    distancia_km: distanciaKm,
    duracao_horas: duracaoHoras,
    tempo_estimado_horas: tempoEstimadoHoras,
  };
}
