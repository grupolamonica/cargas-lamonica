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
    expect(p.license_type).toBe(9); // AE
    expect(p.birth_day).toBe("1997-08-10");
  });
});
