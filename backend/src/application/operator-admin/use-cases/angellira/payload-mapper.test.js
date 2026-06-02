import { describe, expect, it } from "vitest";

import {
  mapMotoristaPayload,
  mapProprietarioPayload,
  mapVeiculoPayload,
  resolveVehicleOwner,
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

// ── RG-parse fallback (OCR CNH fix) ─────────────────────────────────────────
describe("mapMotoristaPayload / RG concatenado", () => {
  it("deriva rg_orgao/rg_uf de um `rg` UF-prefixado (JACKSON: 'MG9014856 SSP MG')", () => {
    const dados = {
      motorista: {
        nome: "Jackson",
        cpf: "12345678901",
        rg: "MG9014856 SSP MG",
        telefone_primario: "31999998888",
      },
    };
    const { motorista } = mapMotoristaPayload(dados);
    expect(motorista.rg).toBe("MG9014856");
    expect(motorista.rg_orgao).toBe("SSP");
    expect(motorista.rg_uf).toBe("MG");
  });

  it("respeita rg_orgao/rg_uf já preenchidos (não sobrescreve)", () => {
    const dados = {
      motorista: {
        nome: "Maria",
        cpf: "12345678901",
        rg: "9014856",
        rg_orgao: "DETRAN",
        rg_uf: "SP",
        telefone_primario: "11999998888",
      },
    };
    const { motorista } = mapMotoristaPayload(dados);
    expect(motorista.rg).toBe("9014856");
    expect(motorista.rg_orgao).toBe("DETRAN");
    expect(motorista.rg_uf).toBe("SP");
  });

  it("forward das chaves de CNH (registro/codigo_seguranca/uf_emissor/primeira_emissao)", () => {
    const dados = {
      motorista: { nome: "Ana", cpf: "12345678901", telefone_primario: "11999998888" },
      cnh: {
        registro: "01234567890",
        categoria: "e",
        codigo_seguranca: "987654321",
        uf_emissor: "sp",
        validade: "2030-05-10",
        primeira_emissao: "2005-03-01",
      },
    };
    const { cnh } = mapMotoristaPayload(dados);
    expect(cnh.registro).toBe("01234567890");
    expect(cnh.categoria).toBe("E");
    expect(cnh.codigo_seguranca).toBe("987654321");
    expect(cnh.uf_emissor).toBe("SP");
    expect(cnh.validade).toBe("10/05/2030");
    expect(cnh.primeira_emissao).toBe("01/03/2005");
  });
});

describe("mapProprietarioPayload / RG concatenado (PF)", () => {
  it("deriva rg_orgao/rg_uf de um `rg` UF-prefixado", () => {
    const { tipo, payload } = mapProprietarioPayload(
      {
        doc: "12345678901",
        nome: "Carlos",
        rg: "SP123456789 SSP SP",
        data_nascimento: "1980-01-01",
      },
      "cpf",
    );
    expect(tipo).toBe("PF");
    expect(payload.rg).toBe("SP123456789");
    expect(payload.rg_orgao).toBe("SSP");
    expect(payload.rg_uf).toBe("SP");
  });
});

// ── resolveVehicleOwner — owner=motorista herda RG órgão/UF (caso 649 JACKSON) ──
describe("resolveVehicleOwner / owner é o motorista", () => {
  const dados = {
    motorista: {
      cpf: "012.307.146-18",
      nome: "JACKSON CARLOS SILVA DOS SANTOS",
      data_nascimento: "11/05/1979",
      rg: "MG9014856", // UF-prefixado, token único — parseRg não separa sozinho
      rg_orgao: "SSP",
      rg_uf: "MG",
      nome_mae: "AILANA DO CARMO SILVA DOS SANTOS",
      endereco: { cep: "17500000", numero: "100", logradouro: "RUA X", cidade: "MARILIA", uf: "SP" },
    },
    cavalo: {
      placa: "HNX0E60",
      owner_doc: "01230714618",
      owner_doc_type: "cpf",
      owner_nome: "JACKSON CARLOS SILVA DOS SANTOS",
    },
  };

  it("herda rg_orgao/rg_uf do motorista quando o owner é a mesma pessoa", () => {
    const owner = resolveVehicleOwner(dados, dados.cavalo);
    expect(owner._is_driver).toBe(true);
    expect(owner.rg).toBe("MG9014856");
    expect(owner.rg_orgao).toBe("SSP");
    expect(owner.rg_uf).toBe("MG");
  });

  it("mapProprietarioPayload PF preserva rg_orgao/rg_uf herdados (sem perder no parse)", () => {
    const owner = resolveVehicleOwner(dados, dados.cavalo);
    const { tipo, payload } = mapProprietarioPayload(owner, owner.doc_type, dados.motorista.endereco);
    expect(tipo).toBe("PF");
    expect(payload.rg).toBe("MG9014856");
    expect(payload.rg_orgao).toBe("SSP");
    expect(payload.rg_uf).toBe("MG");
    expect(payload.data_nascimento).toBe("11/05/1979");
  });

  it("aceita owner_rg_orgao/owner_rg_uf explícitos do veículo (owner terceiro)", () => {
    const d = {
      motorista: { cpf: "11111111111" },
      cavalo: {
        placa: "ABC1D23",
        owner_doc: "22222222222",
        owner_doc_type: "cpf",
        owner_nome: "TERCEIRO",
        owner_rg: "5544332",
        owner_rg_orgao: "DETRAN",
        owner_rg_uf: "RJ",
      },
    };
    const owner = resolveVehicleOwner(d, d.cavalo);
    expect(owner._is_driver).toBe(false);
    expect(owner.rg_orgao).toBe("DETRAN");
    expect(owner.rg_uf).toBe("RJ");
  });
});
