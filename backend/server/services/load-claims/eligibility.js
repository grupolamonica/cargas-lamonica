import { normalizeText, parseLocationUf } from "./helpers.js";

function isVehicleCompatible(driverProfile, loadRow) {
  const loadVehicleProfile = normalizeText(loadRow.perfil || loadRow.cliente_tipo_veiculo || "");
  const driverVehicleProfile = normalizeText(driverProfile.vehicle_profile || "");

  if (!loadVehicleProfile || !driverVehicleProfile) {
    return true;
  }

  return loadVehicleProfile === driverVehicleProfile;
}

function isRegionAllowed(driverProfile, loadRow) {
  if (!Array.isArray(driverProfile.allowed_regions) || driverProfile.allowed_regions.length === 0) {
    return true;
  }

  const allowedRegions = new Set(driverProfile.allowed_regions.map((region) => String(region).trim().toUpperCase()).filter(Boolean));
  const originUf = parseLocationUf(loadRow.origem);
  const destinationUf = parseLocationUf(loadRow.destino);

  if (!originUf && !destinationUf) {
    return true;
  }

  return Boolean((originUf && allowedRegions.has(originUf)) || (destinationUf && allowedRegions.has(destinationUf)));
}

export function evaluateDriverEligibility({ driverProfile, loadRow }) {
  const reasons = [];

  if (!driverProfile) {
    reasons.push("DRIVER_PROFILE_NOT_FOUND");
  }

  if (driverProfile && !driverProfile.active) {
    reasons.push("DRIVER_INACTIVE");
  }

  if (driverProfile && driverProfile.operational_blocked) {
    reasons.push("OPERATIONAL_BLOCK");
  }

  if (driverProfile && !driverProfile.documents_valid) {
    reasons.push("DOCUMENTS_INVALID");
  }

  if (driverProfile && !isVehicleCompatible(driverProfile, loadRow)) {
    reasons.push("VEHICLE_PROFILE_MISMATCH");
  }

  if (driverProfile && !isRegionAllowed(driverProfile, loadRow)) {
    reasons.push("REGION_NOT_ALLOWED");
  }

  if (driverProfile && loadRow.cliente_exige_antt && !driverProfile.antt_valid) {
    reasons.push("ANTT_REQUIRED");
  }

  if (driverProfile && loadRow.cliente_exige_rastreamento && !driverProfile.tracking_enabled) {
    reasons.push("TRACKING_REQUIRED");
  }

  if (driverProfile && loadRow.cliente_exige_seguro && !driverProfile.insurance_valid) {
    reasons.push("INSURANCE_REQUIRED");
  }

  if (driverProfile && loadRow.cliente_exige_carga_monitorada && !driverProfile.monitoring_capable) {
    reasons.push("MONITORING_REQUIRED");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    rejectedReason: reasons[0] ?? null,
  };
}
