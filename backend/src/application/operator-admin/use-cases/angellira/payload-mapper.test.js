import { describe, expect, it } from "vitest";

import {
  mapVeiculoPayload,
  resolveVehicleRntrc,
} from "./payload-mapper.js";

// ── resolveVehicleRntrc (DC-128) ────────────────────────────────────────────
describe("resolveVehicleRntrc / cavalo", () => {
  it("usa o antt explícito do próprio veículo (prioridade máxima)", () => {
    const dados = {
      cavalo: { placa: "ABC1D23", antt: "057.984.877" },
      cavalo_owner: { rntrc: "999999999" },
    };
    // veiculo.antt vence o owner — e vem só-dígitos
    expect(resolveVehicleRntrc(dados, "cavalo")).toBe("057984877");
  });

  it("cai pro RNTRC do proprietário (cascata ANTT) quando o veículo não tem antt", () => {
    const dados = {
      cavalo: { placa: "ABC1D23", owner_doc: "60300808000116", owner_doc_type: "cnpj" },
      cavalo_owner: { doc: "60300808000116", rntrc: "057984877", rntrc_via: "antt" },
    };
    expect(resolveVehicleRntrc(dados, "cavalo")).toBe("057984877");
  });

  it("cai pro RNTRC do titular ANTT (arrendamento) quando o owner não tem rntrc próprio", () => {
    const dados = {
      cavalo: { placa: "ABC1D23" },
      cavalo_owner: {
        doc: "12345678901",
        antt_titular: { doc: "60300808000116", rntrc: "057984877" },
      },
    };
    expect(resolveVehicleRntrc(dados, "cavalo")).toBe("057984877");
  });

  it("retorna '' quando a cascata não resolveu nada (operador informa manualmente)", () => {
    const dados = {
      cavalo: { placa: "ABC1D23", owner_doc: "12345678901" },
      cavalo_owner: { doc: "12345678901" },
    };
    expect(resolveVehicleRntrc(dados, "cavalo")).toBe("");
  });
});

describe("resolveVehicleRntrc / carreta", () => {
  it("usa o RNTRC do carreta_owner[idx]", () => {
    const dados = {
      carretas: [{ placa: "XYZ1A23" }],
      carreta_owners: [{ doc: "11122233000199", rntrc: "012345678" }],
    };
    expect(resolveVehicleRntrc(dados, "carreta", 0)).toBe("012345678");
  });

  it("herda o RNTRC do cavalo_owner quando a carreta reaproveita o owner do cavalo", () => {
    const dados = {
      cavalo: { placa: "ABC1D23" },
      cavalo_owner: { doc: "60300808000116", rntrc: "057984877" },
      carretas: [{ placa: "XYZ1A23" }],
      carreta_owners: [],
      owner_reuse: { carreta_owners_reused: ["cavalo_owner"] },
    };
    expect(resolveVehicleRntrc(dados, "carreta", 0)).toBe("057984877");
  });

  it("NÃO herda do cavalo quando a carreta tem owner próprio (sem reuse)", () => {
    const dados = {
      cavalo_owner: { rntrc: "057984877" },
      carretas: [{ placa: "XYZ1A23" }],
      carreta_owners: [{ doc: "11122233000199" }], // sem rntrc
      owner_reuse: { carreta_owners_reused: ["none"] },
    };
    expect(resolveVehicleRntrc(dados, "carreta", 0)).toBe("");
  });
});

// ── mapVeiculoPayload — fallback de RNTRC ───────────────────────────────────
describe("mapVeiculoPayload / antt fallback", () => {
  it("usa o rntrcFallback quando o veículo não tem antt próprio", () => {
    const payload = mapVeiculoPayload({ placa: "ABC1D23" }, "057984877");
    expect(payload.antt).toBe("057984877");
  });

  it("o antt do veículo vence o fallback", () => {
    const payload = mapVeiculoPayload({ placa: "ABC1D23", antt: "111111111" }, "057984877");
    expect(payload.antt).toBe("111111111");
  });

  it("sem antt e sem fallback → '' (mantém comportamento anterior)", () => {
    const payload = mapVeiculoPayload({ placa: "ABC1D23" });
    expect(payload.antt).toBe("");
  });
});
