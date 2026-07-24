import { describe, expect, it } from "vitest";

import { mapSpxMotoristaPayload } from "./payload-mapper.js";

const DADOS = {
  motorista: {
    nome: "JORGE FERNANDO SILVA FERREIRA",
    cpf: "019.724.126-39",
    telefones: ["(38) 99999-0000"],
    telefone_primario: "(38) 99999-0000",
    data_nascimento: "10/08/1997",
    endereco: {
      cep: "39400000", numero: "100", logradouro: "RUA CORONEL SPYER",
      bairro: "CENTRO", cidade: "MONTES CLAROS", uf: "MG",
    },
    cnh: { registro: "06537742154", categoria: "AE", validade: "2035-07-21" },
  },
  cavalo: { placa: "NLN8428", renavam: "00268719179", marca_modelo: "SCANIA / G 420 A6X2", ano_fab: 2010 },
  cavalo_owner: { razao_social: "JOAO DIMAS FERREIRA" },
};

describe("mapSpxMotoristaPayload — contact_number + license_number (DC-111)", () => {
  it("preenche contact_number a partir de motorista.telefones[0] (não do inexistente .telefone)", () => {
    const p = mapSpxMotoristaPayload(DADOS);
    // o normalizador Angellira emite telefones[]; ler `.telefone` deixava isso undefined → SPX 422
    expect(p.contact_number).toBe("38999990000");
  });

  it("preenche license_number a partir de cnh.registro (não do inexistente cnh.numero)", () => {
    const p = mapSpxMotoristaPayload(DADOS);
    expect(p.license_number).toBe("06537742154");
  });

  it("mantém os demais campos essenciais do SPX", () => {
    const p = mapSpxMotoristaPayload(DADOS);
    expect(p.cpf).toBe("01972412639");
    expect(p.driver_name).toBe("JORGE FERNANDO SILVA FERREIRA");
    expect(p.license_plate).toBe("NLN8428");
    expect(p.license_type).toBe(29); // AE → SPX CNHType.AE = 29
    expect(p.birth_day).toBe("1997-08-10");
  });
});

describe("mapSpxMotoristaPayload — license_type espelha K.CNHType do bot SPX", () => {
  // IDs autoritativos de bots/spx/backend/spx_robo/constants.py::CNHType.
  // O bot repassa license_type CRU ao SPX (sem re-mapear), então o mapper
  // DEVE emitir o id correto da Shopee, não um inteiro sequencial.
  const CNHTYPE = { A: 3, B: 23, C: 0, D: 24, E: 25, AB: 26, AC: 27, AD: 28, AE: 29 };
  for (const [cat, id] of Object.entries(CNHTYPE)) {
    it(`categoria ${cat} → ${id}`, () => {
      const p = mapSpxMotoristaPayload({
        motorista: { cpf: "01972412639", nome: "X", telefones: ["38999990000"], cnh: { registro: "1", categoria: cat } },
        cavalo: { placa: "ABC1D23" },
      });
      expect(p.license_type).toBe(id);
    });
  }

  it("categoria AD do 649 (JACKSON) → 28", () => {
    const p = mapSpxMotoristaPayload({
      motorista: { cpf: "01230714618", nome: "JACKSON", telefones: ["71995626565"], cnh: { registro: "03577860007", categoria: "AD" } },
      cavalo: { placa: "HNX0E60" },
    });
    expect(p.license_type).toBe(28);
  });
});

describe("mapSpxMotoristaPayload — defaults alinhados à produção", () => {
  it("function_type_list default = [1] (DELIVERY — o que os motoristas reais da LAMONICA usam; [3] dá 'Station not exist')", () => {
    expect(mapSpxMotoristaPayload(DADOS).function_type_list).toEqual([1]);
  });
  it("linehaul_station_name default = SoC_BA_Simoes Filho", () => {
    expect(mapSpxMotoristaPayload(DADOS).linehaul_station_name).toBe("SoC_BA_Simoes Filho");
  });
  it("contract_type default = 364; do_draft_save default = true", () => {
    const p = mapSpxMotoristaPayload(DADOS);
    expect(p.contract_type).toBe(364);
    expect(p.do_draft_save).toBe(true);
  });
  it("rad_expire_date nunca é null (cai no default hoje+90d)", () => {
    expect(mapSpxMotoristaPayload(DADOS).rad_expire_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("mapSpxMotoristaPayload — veículo: marca, owner, multi-placa", () => {
  it("vehicle_manufacturer = só a MARCA em uppercase (sem modelo) p/ bater o OCR", () => {
    // marca_modelo "SCANIA / G 420 A6X2" → "SCANIA"
    expect(mapSpxMotoristaPayload(DADOS).vehicle_manufacturer).toBe("SCANIA");
  });
  it("vehicle_owner_name prefere proprietário do CRLV; senão owner; senão motorista", () => {
    expect(mapSpxMotoristaPayload({ ...DADOS, cavalo: { ...DADOS.cavalo, proprietario: "TRANSP REAL LTDA" } }).vehicle_owner_name).toBe("TRANSP REAL LTDA");
    expect(mapSpxMotoristaPayload(DADOS).vehicle_owner_name).toBe("JOAO DIMAS FERREIRA"); // cavalo_owner.razao_social
  });
  it("só cavalo → TRUCK (49, o que os motoristas reais usam; não TRUCK - EXPRESSA/65), placa única, quantity 1", () => {
    const p = mapSpxMotoristaPayload(DADOS);
    expect(p.vehicle_type_name).toBe("TRUCK");
    expect(p.license_plate).toBe("NLN8428");
    expect(p.plate_number_quantity).toBe(1);
  });
  it("cavalo + carreta → CARRETA, placas 'CAV,CAR', quantity 2", () => {
    const p = mapSpxMotoristaPayload({ ...DADOS, carretas: [{ placa: "ABC1D23" }] });
    expect(p.vehicle_type_name).toBe("CARRETA");
    expect(p.license_plate).toBe("NLN8428,ABC1D23");
    expect(p.plate_number_quantity).toBe(2);
  });
});

describe("mapSpxMotoristaPayload — toIsoDate robusto + cnh_remarks whitelist", () => {
  it("aceita separador '.' e ano de 2 dígitos; rejeita data inválida → ''", () => {
    expect(mapSpxMotoristaPayload({ ...DADOS, motorista: { ...DADOS.motorista, data_nascimento: "10.08.97" } }).birth_day).toBe("1997-08-10");
    expect(mapSpxMotoristaPayload({ ...DADOS, motorista: { ...DADOS.motorista, data_nascimento: "31/02/2020" } }).birth_day).toBe("");
  });
  it("cnh_remarks: só tokens da whitelist (EAR ok, lixo descartado)", () => {
    const p = mapSpxMotoristaPayload({ ...DADOS, motorista: { ...DADOS.motorista, cnh_observacoes: "EAR, BLABLA / CETPP" } });
    expect(p.cnh_remarks).toEqual(["EAR", "CETPP"]);
  });
  it("cnh_remarks: lê a observação NESTED motorista.cnh.observacoes (wizard v2 persiste aqui)", () => {
    const p = mapSpxMotoristaPayload({
      ...DADOS,
      motorista: { ...DADOS.motorista, cnh: { ...(DADOS.motorista.cnh || {}), observacoes: "EAR" } },
    });
    expect(p.cnh_remarks).toEqual(["EAR"]);
  });
});

describe("mapSpxMotoristaPayload — overrides do pipeline (anexos + vigência)", () => {
  it("injeta *_path, risk_doc_path e rad_expire_date via overrides", () => {
    const p = mapSpxMotoristaPayload(DADOS, {
      cnh_frente_path: "/s/cnh_f", cnh_verso_path: "/s/cnh_v", selfie_path: "/s/self",
      crlv_path: "/s/crlv", risk_doc_path: "/s/risk", rad_expire_date: "2026-09-01",
    });
    expect(p.cnh_frente_path).toBe("/s/cnh_f");
    expect(p.cnh_verso_path).toBe("/s/cnh_v");
    expect(p.selfie_path).toBe("/s/self");
    expect(p.crlv_path).toBe("/s/crlv");
    expect(p.risk_doc_path).toBe("/s/risk");
    expect(p.rad_expire_date).toBe("2026-09-01");
  });
});
