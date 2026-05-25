import { describe, expect, it } from "vitest";

import { candidaturaSubmitSchema } from "./candidatura-schemas.js";

/**
 * Tests do PLAN-CADASTRO-PARITY — garantem que os novos campos opcionais
 * adicionados aos sub-schemas (motorista, veiculo, owner PF/PJ) sao aceitos
 * sem quebrar o fluxo atual (.strict() bloqueia chaves nao mapeadas, entao
 * cada novo campo precisa estar declarado no schema).
 *
 * Strategy: payload baseline minimo + campos novos espalhados — se algum
 * for rejeitado, o teste falha apontando exatamente qual campo nao foi
 * declarado.
 */

const BASE_MOTORISTA = {
  nome: "Joao da Silva",
  data_nascimento: "1980-01-01",
  cnh: { categoria: "E", validade: "2030-12-31" },
  telefones: ["11999990000"],
  telefone_primario: "11999990000",
  endereco: {
    cep: "01310000",
    numero: "100",
    logradouro: "Avenida Paulista",
    cidade: "Sao Paulo",
    uf: "SP",
  },
  tag_pedagio: "sem_parar",
  pancary_autodeclaration: "sim",
};

const BASE_CAVALO = {
  placa: "ABC1D23",
  owner_doc: "12345678901",
  owner_doc_type: "cpf",
};

const BASE_OWNER_PF = {
  tipo: "pf",
  doc: "12345678901",
  nome: "Maria Oliveira",
  dados_bancarios: {
    banco_compe: "001",
    banco_nome: "Banco do Brasil",
    agencia: "1234",
    conta: "5678",
    tipo: "corrente",
  },
  // Iter #7 — comprovante de residencia obrigatorio para owner PF.
  endereco: {
    cep: "01310-100",
    numero: "1000",
    logradouro: "Av Paulista",
    comprovante_storage_path: "cadastro-drafts/owner-cavalo/comprov.jpg",
  },
};

const BASE_OWNER_PJ = {
  tipo: "pj",
  doc: "12345678000100",
  nome: "Empresa LTDA",
  dados_bancarios: {
    banco_compe: "001",
    banco_nome: "Banco do Brasil",
    agencia: "1234",
    conta: "5678",
    tipo: "corrente",
  },
};

describe("candidatura-schemas — paridade /cadastro (PLAN-CADASTRO-PARITY)", () => {
  it("motorista aceita filiacao + RG opcionais", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: {
          ...BASE_MOTORISTA,
          nome_pai: "Antonio da Silva",
          nome_mae: "Joana da Silva",
          naturalidade: "Sao Paulo/SP",
          rg: "12.345.678-9",
          rg_orgao: "SSP",
          rg_uf: "SP",
        },
        cavalo: BASE_CAVALO,
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("motorista aceita cnh com chaves extras (codigo_seguranca, primeira_emissao)", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: {
          ...BASE_MOTORISTA,
          cnh: {
            categoria: "E",
            validade: "2030-12-31",
            registro: "12345678901",
            codigo_seguranca: "ABC123",
            numero_espelho: "999999",
            uf_emissor: "SP",
            primeira_emissao: "2010-05-01",
          },
        },
        cavalo: BASE_CAVALO,
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("cavalo aceita detalhes extras (modelo, tipo, carroceria, eixos, frota)", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: {
          ...BASE_CAVALO,
          modelo: "Volvo FH 460",
          ano_fabricacao: 2018,
          tipo: "Cavalo mecanico",
          carroceria: "Graneleira",
          uf_emplacamento: "SP",
          cidade_emplacamento: "Sao Paulo",
          eixos: 5,
          frota: "proprio",
          antt: "12345678",
          ultimo_licenciamento: "2024-03-01",
        },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("cavalo aceita ano_fabricacao e eixos como string (transform p/ number)", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: {
          ...BASE_CAVALO,
          ano_fabricacao: "2020",
          eixos: "6",
        },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dados.cavalo.ano_fabricacao).toBe(2020);
      expect(result.data.dados.cavalo.eixos).toBe(6);
    }
  });

  it("cavalo rejeita frota fora do enum", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: { ...BASE_CAVALO, frota: "invalido" },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("owner PF aceita filiacao/RG/CNH extras", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: BASE_CAVALO,
        cavalo_owner: {
          ...BASE_OWNER_PF,
          nome_pai: "Carlos Oliveira",
          nome_mae: "Sandra Oliveira",
          naturalidade: "Curitiba/PR",
          rg: "9.876.543-2",
          rg_orgao: "SSP",
          rg_uf: "PR",
          situacao_cnh: "vigente",
          tem_cnh: true,
          cnh: {
            registro: "12345678901",
            categoria: "AB",
            validade: "2032-06-15",
            codigo_seguranca: "XYZ987",
            numero_espelho: "888888",
            uf_emissor: "PR",
            primeira_emissao: "2005-08-10",
          },
        },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("owner PJ aceita inscricao_estadual + isento_ie", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: { ...BASE_CAVALO, owner_doc: "12345678000100", owner_doc_type: "cnpj" },
        cavalo_owner: {
          ...BASE_OWNER_PJ,
          inscricao_estadual: "123.456.789.000",
          isento_ie: false,
        },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("owner PJ aceita isento_ie=true sem inscricao_estadual", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: { ...BASE_CAVALO, owner_doc: "12345678000100", owner_doc_type: "cnpj" },
        cavalo_owner: {
          ...BASE_OWNER_PJ,
          isento_ie: true,
        },
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("payload baseline (sem nenhum campo de paridade) continua valido", () => {
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: BASE_CAVALO,
        carretas: [],
      },
    };

    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // ── Iter #7 — comprovante de residencia obrigatorio para owner PF ─────
  it("[iter#7] owner PF sem comprovante_storage_path REJEITA (cavalo)", () => {
    const { endereco: _endereco, ...ownerSemComprov } = BASE_OWNER_PF;
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: BASE_CAVALO,
        cavalo_owner: ownerSemComprov,
        carretas: [],
      },
    };
    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/comprovante de residencia/i);
    }
  });

  it("[iter#7] owner PF sem comprovante_storage_path REJEITA (carreta)", () => {
    const { endereco: _endereco, ...ownerSemComprov } = BASE_OWNER_PF;
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: BASE_CAVALO,
        carretas: [{ placa: "DEF4G56", owner_doc: "98765432100", owner_doc_type: "cpf" }],
        carreta_owners: [{ ...ownerSemComprov, doc: "98765432100" }],
      },
    };
    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("[iter#7] owner PJ continua sem exigencia de comprovante", () => {
    const { endereco: _endereco, ...ownerPJSemEndereco } = {
      ...BASE_OWNER_PJ,
      endereco: undefined,
    };
    const payload = {
      cargaId: "carga-1",
      dados: {
        motorista: BASE_MOTORISTA,
        cavalo: { ...BASE_CAVALO, owner_doc: "12345678000100", owner_doc_type: "cnpj" },
        cavalo_owner: ownerPJSemEndereco,
        carretas: [],
      },
    };
    const result = candidaturaSubmitSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
