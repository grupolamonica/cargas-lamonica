import { describe, expect, it } from "vitest";
import { buildEnrichedUpsertRow } from "./sheet-monitor-enrichment.js";

const ctx = (over = {}) => ({
  nameToCpf: {},
  nameToCpfDisplay: {},
  angelliraDrivers: {},
  vehiclesByPlate: {},
  angelliraVehicles: {},
  ...over,
});

describe("buildEnrichedUpsertRow", () => {
  it("carga do sistema: grava lh 'cargo:<id>' + cargo_id + dados do motorista", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:abc", cargoId: "abc", motoristas: "João Silva", cavalo: "", carreta: "" },
      ctx({
        nameToCpf: { "João Silva": "12345" },
        nameToCpfDisplay: { "João Silva": "JOAO SILVA" },
        angelliraDrivers: { 12345: { found: true, status: "FOUND", validUntil: "2027-01-01", statusText: "VIGENTE" } },
      }),
    );
    expect(r.lh).toBe("cargo:abc");
    expect(r.cargo_id).toBe("abc");
    expect(r.aspx_cpf).toBe("12345");
    expect(r.aspx_display_name).toBe("JOAO SILVA");
    expect(r.angellira_driver_found).toBe(true);
    expect(r.angellira_driver_valid_until).toBe("2027-01-01");
  });

  it("carga do sistema SEM motorista: linha esqueleto (cargo_id presente, campos null)", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:xyz", cargoId: "xyz", motoristas: "", cavalo: "", carreta: "" },
      ctx(),
    );
    expect(r.lh).toBe("cargo:xyz");
    expect(r.cargo_id).toBe("xyz");
    expect(r.driver_name).toBeNull();
    expect(r.aspx_cpf).toBeNull();
    expect(r.angellira_driver_found).toBeNull();
    expect(r.enriched_at).toBeTruthy(); // existe registro → não fica "não consultado"
  });

  it("linha da planilha: cargo_id null", () => {
    const r = buildEnrichedUpsertRow({ lh: "LT0Q6R0291RO1", motoristas: "", cavalo: "", carreta: "" }, ctx());
    expect(r.lh).toBe("LT0Q6R0291RO1");
    expect(r.cargo_id).toBeNull();
  });

  it("veículo do cache (db) é refletido", () => {
    const r = buildEnrichedUpsertRow(
      { lh: "cargo:v", cargoId: "v", motoristas: "", cavalo: "ABC-1234", carreta: "" },
      ctx({ vehiclesByPlate: { ABC1234: { vehicle_type: "CARRETA", angellira_status: "FOUND", angellira_valid_until: "2027-01-01" } } }),
    );
    expect(r.cavalo_plate).toBe("ABC1234"); // normalizado
    expect(r.cavalo_source).toBe("db");
    expect(r.cavalo_angellira_found).toBe(true);
  });
});
