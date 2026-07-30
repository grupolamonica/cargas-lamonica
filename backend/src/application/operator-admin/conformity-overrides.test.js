import { describe, expect, it } from "vitest";

import {
  normalizeCpfKey,
  normalizePlateKey,
  applyConformityOverridesToEnriched,
} from "./conformity-overrides.js";

describe("conformity-overrides normalização", () => {
  it("CPF vira só dígitos", () => {
    expect(normalizeCpfKey("123.456.789-00")).toBe("12345678900");
    expect(normalizeCpfKey(null)).toBe("");
  });
  it("placa sem separadores + maiúscula", () => {
    expect(normalizePlateKey("abc-1d23")).toBe("ABC1D23");
    expect(normalizePlateKey(" xyz 9k8 ")).toBe("XYZ9K8");
  });
});

describe("applyConformityOverridesToEnriched", () => {
  const overrides = {
    driver: new Map([["12345678900", { decision: "NOT_APPROVED", observacao: "bloqueado", setBy: "Op", setAt: "2026-07-30T00:00:00Z" }]]),
    vehicle: new Map([["ABC1D23", { decision: "APPROVED", observacao: "ok", setBy: null, setAt: null }]]),
  };

  it("anexa o verdito manual por CPF (ASPX) e por placa do cavalo", () => {
    const maps = {
      enrichedByLh: {
        LT1: { lh: "LT1", aspx_cpf: "123.456.789-00", cavalo_plate: "ABC-1D23", carreta_plate: null },
      },
      enrichedByCargoId: {},
    };
    const out = applyConformityOverridesToEnriched(maps, overrides);
    const row = out.enrichedByLh.LT1;
    expect(row.angellira_driver_manual).toMatchObject({ decision: "NOT_APPROVED", observacao: "bloqueado" });
    expect(row.cavalo_angellira_manual).toMatchObject({ decision: "APPROVED" });
    expect(row.carreta_angellira_manual).toBeNull();
    // não muta a linha original (cache)
    expect(maps.enrichedByLh.LT1).not.toHaveProperty("angellira_driver_manual");
  });

  it("usa o CPF de angellira_driver_details quando não há aspx_cpf", () => {
    const maps = {
      enrichedByLh: { LT2: { lh: "LT2", aspx_cpf: null, angellira_driver_details: { cpf: "12345678900" }, cavalo_plate: null, carreta_plate: null } },
      enrichedByCargoId: {},
    };
    const out = applyConformityOverridesToEnriched(maps, overrides);
    expect(out.enrichedByLh.LT2.angellira_driver_manual).toMatchObject({ decision: "NOT_APPROVED" });
  });

  it("sem override, devolve a MESMA referência (não clona)", () => {
    const row = { lh: "LT3", aspx_cpf: "000", cavalo_plate: "ZZZ0Z00", carreta_plate: null };
    const maps = { enrichedByLh: { LT3: row }, enrichedByCargoId: {} };
    const out = applyConformityOverridesToEnriched(maps, overrides);
    expect(out.enrichedByLh.LT3).toBe(row);
  });
});
