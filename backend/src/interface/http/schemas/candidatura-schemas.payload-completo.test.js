import { describe, expect, it } from "vitest";

import { candidaturaSubmitSchema } from "./candidatura-schemas.js";

/**
 * Contrato de submit completo — garante que o schema Zod aceita um payload
 * com TODAS as 7 entidades que o usuario pediu pra rastrear:
 *
 *   1. motorista
 *   2. cavalo
 *   3. carreta
 *   4. cavalo_owner            (proprietario do cavalo)
 *   5. carreta_owners[0]       (proprietario da carreta)
 *   6. cavalo_owner.antt_titular   (proprietario da ANTT do cavalo)
 *   7. carreta_owners[0].antt_titular (proprietario da ANTT da carreta)
 *
 * Esse teste e o "wire format gate": se algum desses campos for removido do
 * schema, o submit do wizard para de aceitar payloads que o frontend ja envia
 * (e quebra a persistencia no banco em silencio). Roda em <100ms.
 */
describe("candidaturaSubmitSchema — payload completo com todas as 7 entidades", () => {
  const fullPayload = {
    cargaId: "L-FULL-PAYLOAD-001",
    dados: {
      motorista: {
        nome: "Motorista Completo Teste",
        telefones: ["11999998888"],
        telefone_primario: "11999998888",
        endereco: {
          cep: "01310100",
          numero: "123",
          logradouro: "Av. Paulista",
          bairro: "Bela Vista",
          cidade: "Sao Paulo",
          uf: "SP",
        },
        tag_pedagio: "sem_parar",
        pancary_autodeclaration: "sim",
      },
      cavalo: {
        placa: "ABC1D23",
        renavam: "12345678901",
        chassi: "9BWZZZ377VT004251",
        marca: "Volvo",
        ano: 2022,
        cor: "Branca",
        owner_doc: "12345678000199",
        owner_doc_type: "cnpj",
      },
      cavalo_owner: {
        tipo: "pj",
        doc: "12345678000199",
        nome: "Transportadora CAVALO LTDA",
        dados_bancarios: {
          banco_compe: "001",
          banco_nome: "Banco do Brasil",
          agencia: "1234",
          conta: "11111-1",
          tipo: "corrente",
        },
        antt_titular: {
          tipo: "pf",
          doc: "98765432100",
          nome: "Titular ANTT do Cavalo",
          rntrc: "12345678",
          pis: "12345678901",
          estado_civil: "casado",
          cor_raca: "branca",
          dados_bancarios: {
            banco_compe: "237",
            banco_nome: "Bradesco",
            agencia: "9999",
            conta: "55555-5",
            tipo: "corrente",
          },
        },
      },
      carretas: [
        {
          placa: "XYZ9F87",
          renavam: "98765432100",
          chassi: "9CCYYY124VT004251",
          marca: "Randon",
          ano: 2021,
          cor: "Vermelha",
          owner_doc: "55544433000122",
          owner_doc_type: "cnpj",
        },
      ],
      carreta_owners: [
        {
          tipo: "pj",
          doc: "55544433000122",
          nome: "Transportadora CARRETA LTDA",
          dados_bancarios: {
            banco_compe: "104",
            banco_nome: "Caixa",
            agencia: "5555",
            conta: "22222-2",
            tipo: "corrente",
          },
          antt_titular: {
            tipo: "pf",
            doc: "11122233344",
            nome: "Titular ANTT da Carreta",
            rntrc: "87654321",
            dados_bancarios: {
              banco_compe: "341",
              banco_nome: "Itau",
              agencia: "4321",
              conta: "33333-3",
              tipo: "corrente",
            },
          },
        },
      ],
    },
  };

  it("aceita payload completo com motorista + cavalo + carreta + 4 proprietarios", () => {
    const parsed = candidaturaSubmitSchema.safeParse(fullPayload);

    if (!parsed.success) {
      throw new Error(
        `Schema rejeitou payload completo: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }

    const data = parsed.data;

    expect(data.dados.motorista.nome).toBe("Motorista Completo Teste");
    expect(data.dados.cavalo.placa).toBe("ABC1D23");
    expect(data.dados.carretas[0].placa).toBe("XYZ9F87");
    expect(data.dados.cavalo_owner.doc).toBe("12345678000199");
    expect(data.dados.carreta_owners[0].doc).toBe("55544433000122");
    expect(data.dados.cavalo_owner.antt_titular.doc).toBe("98765432100");
    expect(data.dados.carreta_owners[0].antt_titular.doc).toBe("11122233344");
  });

  it("rejeita se faltar antt_titular.doc (PROPRIETARIO ANTT incompleto)", () => {
    const broken = JSON.parse(JSON.stringify(fullPayload));
    delete broken.dados.cavalo_owner.antt_titular.doc;
    const parsed = candidaturaSubmitSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it("rejeita se faltar carreta_owners[0].nome (PROPRIETARIO carreta incompleto)", () => {
    const broken = JSON.parse(JSON.stringify(fullPayload));
    delete broken.dados.carreta_owners[0].nome;
    const parsed = candidaturaSubmitSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it("aceita sem antt_titular (caso default: titular ANTT == owner CRLV)", () => {
    const noTitular = JSON.parse(JSON.stringify(fullPayload));
    delete noTitular.dados.cavalo_owner.antt_titular;
    delete noTitular.dados.carreta_owners[0].antt_titular;
    const parsed = candidaturaSubmitSchema.safeParse(noTitular);
    expect(parsed.success).toBe(true);
  });
});
