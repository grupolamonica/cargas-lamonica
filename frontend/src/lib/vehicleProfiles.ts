export type VehicleProfileValue = "TRUCK" | "CARRETA" | "CARRETA_EXPRESSA" | "BITREM";

interface VehicleProfileOption {
  value: VehicleProfileValue;
  label: string;
  trailerPlateCount: number;
  helperText: string;
}

const VEHICLE_PROFILE_ALIASES = new Map<string, VehicleProfileValue>([
  ["TRUCK", "TRUCK"],
  ["TOCO", "TRUCK"],
  ["3/4", "TRUCK"],
  ["CARRETA", "CARRETA"],
  ["CARRETA_EXPRESSA", "CARRETA_EXPRESSA"],
  ["CARRETA EXPRESSA", "CARRETA_EXPRESSA"],
  ["CARRETA - EXPRESSA", "CARRETA_EXPRESSA"],
  ["BITREM", "BITREM"],
  ["BITRUCK", "BITREM"],
]);

export const VEHICLE_PROFILE_OPTIONS: VehicleProfileOption[] = [
  {
    value: "TRUCK",
    label: "Truck",
    trailerPlateCount: 0,
    helperText: "So placa do cavalo.",
  },
  {
    value: "CARRETA",
    label: "Carreta",
    trailerPlateCount: 1,
    helperText: "Uma placa de carreta.",
  },
  {
    value: "CARRETA_EXPRESSA",
    label: "Carreta Expressa",
    trailerPlateCount: 1,
    helperText: "Uma placa de carreta (servico expresso).",
  },
  {
    value: "BITREM",
    label: "Bitrem",
    trailerPlateCount: 2,
    helperText: "Duas placas de carreta.",
  },
];

function normalizeVehicleProfileKey(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export function normalizeVehicleProfile(
  value: string | null | undefined,
  fallback: VehicleProfileValue = "CARRETA",
): VehicleProfileValue {
  return VEHICLE_PROFILE_ALIASES.get(normalizeVehicleProfileKey(value)) ?? fallback;
}

export function getVehicleProfileOption(value: string | null | undefined) {
  const normalizedValue = normalizeVehicleProfile(value);
  return VEHICLE_PROFILE_OPTIONS.find((option) => option.value === normalizedValue) ?? VEHICLE_PROFILE_OPTIONS[1];
}

export function formatVehicleProfileLabel(value: string | null | undefined) {
  return getVehicleProfileOption(value).label;
}
