export const CANONICAL_VEHICLE_PROFILES = ["TRUCK", "CARRETA", "CARRETA_EXPRESSA", "BITREM"];

const VEHICLE_PROFILE_ALIASES = new Map([
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

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export function normalizeVehicleProfile(value, fallback = null) {
  const normalizedKey = normalizeKey(value);

  if (!normalizedKey) {
    return fallback;
  }

  return VEHICLE_PROFILE_ALIASES.get(normalizedKey) ?? fallback;
}

export function isSupportedVehicleProfile(value) {
  return CANONICAL_VEHICLE_PROFILES.includes(value);
}

export function getTrailerPlateRequirement(vehicleProfile) {
  switch (normalizeVehicleProfile(vehicleProfile, "")) {
    case "TRUCK":
      return 0;
    case "BITREM":
      return 2;
    case "CARRETA":
    case "CARRETA_EXPRESSA":
      return 1;
    default:
      return 1;
  }
}
