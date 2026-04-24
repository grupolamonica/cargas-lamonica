import { describe, expect, it } from "vitest";

import { evaluateDriverEligibility } from "./eligibility.js";

describe("load-claim eligibility", () => {
  it("marks a driver without profile as ineligible", () => {
    const result = evaluateDriverEligibility({
      driverProfile: null,
      loadRow: {
        perfil: "CARRETA",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        cliente_exige_antt: false,
        cliente_exige_rastreamento: false,
        cliente_exige_seguro: false,
        cliente_exige_carga_monitorada: false,
      },
    });

    expect(result).toMatchObject({
      eligible: false,
      rejectedReason: "DRIVER_PROFILE_NOT_FOUND",
      reasons: ["DRIVER_PROFILE_NOT_FOUND"],
    });
  });

  it("revalidates region, vehicle and operational requirements together", () => {
    const result = evaluateDriverEligibility({
      driverProfile: {
        active: true,
        operational_blocked: false,
        documents_valid: true,
        vehicle_profile: "TRUCK",
        allowed_regions: ["MG"],
        antt_valid: false,
        tracking_enabled: false,
        insurance_valid: false,
        monitoring_capable: false,
      },
      loadRow: {
        perfil: "CARRETA",
        origem: "Salvador / BA",
        destino: "Campinas / SP",
        cliente_exige_antt: true,
        cliente_exige_rastreamento: true,
        cliente_exige_seguro: true,
        cliente_exige_carga_monitorada: true,
      },
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      "VEHICLE_PROFILE_MISMATCH",
      "REGION_NOT_ALLOWED",
      "ANTT_REQUIRED",
      "TRACKING_REQUIRED",
      "INSURANCE_REQUIRED",
      "MONITORING_REQUIRED",
    ]);
    expect(result.rejectedReason).toBe("VEHICLE_PROFILE_MISMATCH");
  });
});
