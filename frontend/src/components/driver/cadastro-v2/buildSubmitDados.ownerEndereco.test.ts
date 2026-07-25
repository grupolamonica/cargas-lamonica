import { describe, expect, it } from "vitest";

import { buildSubmitDados } from "./buildSubmitDados";
import type { ConfirmationWizardData } from "./ConfirmationScreen";

/**
 * 2026-07-25 — Regressão LEANDRO (resgate do operador batia em 422 genérico
 * "Payload invalido para a operacao solicitada.").
 *
 * Duas causas de serialização:
 *  1. `buildOwnerEndereco` exigia logradouro → quando o dono PF preenchia
 *     cep+numero+cidade+uf+comprovante mas NÃO a rua (ViaCEP não retornou),
 *     o endereço (e o comprovante) era descartado → superRefine PF falhava.
 *  2. O rastreador emitia `id_rastreador: ""` (campo opcional no wizard),
 *     rejeitado pelo backend `.min(1)`.
 *
 * Fixtures usam `as unknown as ConfirmationWizardData` (tipos profundos, cheios
 * de opcionais) — o que importa é a FORMA do payload de saída (runtime).
 */

describe("buildSubmitDados — endereço do dono PF sem logradouro (regressão LEANDRO)", () => {
  it("emite cavalo_owner.endereco.comprovante_storage_path mesmo sem logradouro", () => {
    const data = {
      stepA: null,
      stepB: { placa: "CUD3H59", ownerDoc: "12345678901", ownerDocType: "cpf", ownerIsDriver: false },
      stepC: {
        owner: { nome: "Dono PF", documento: "123.456.789-01", docType: "cpf" },
        antt: {},
        ownerEndereco: {
          cep: "01310100",
          numero: "100",
          logradouro: "", // vazio de propósito (ViaCEP não retornou a rua)
          bairro: "",
          cidade: "Sao Paulo",
          uf: "SP",
          comprovanteUrl: "cadastro-drafts/owner-cavalo/comprov.jpg",
        },
        ownerComprovanteStoragePath: "cadastro-drafts/owner-cavalo/comprov.jpg",
      },
      stepD: null,
      stepE: {},
      collectedCarretaOwners: [],
    } as unknown as ConfirmationWizardData;

    const dados = buildSubmitDados(data);
    const owner = dados.cavalo_owner as Record<string, unknown>;
    expect(owner?.tipo).toBe("pf");
    const endereco = owner?.endereco as Record<string, unknown>;
    expect(endereco).toBeDefined();
    expect(endereco.comprovante_storage_path).toBe("cadastro-drafts/owner-cavalo/comprov.jpg");
    expect(endereco.cep).toBe("01310100");
    expect(endereco.numero).toBe("100");
    // logradouro vazio é OMITIDO (não enviado como "").
    expect("logradouro" in endereco).toBe(false);
  });
});

describe("buildSubmitDados — rastreador id_equipamento opcional (regressão LEANDRO)", () => {
  const baseStepA = {
    a1: { nome: "Motorista X", cpf: "12345678901" },
    a2: { telefones: ["11999990000"], telefone_primario: "11999990000" },
    a3: { cep: "01310100", numero: "10", logradouro: "Rua Y" },
  };

  it("omite id_rastreador quando id_equipamento está vazio", () => {
    const data = {
      stepA: baseStepA,
      stepB: {
        placa: "CUD3H59", ownerDoc: "12345678901", ownerDocType: "cpf",
        a6: { possui: "sim", rastreador: { empresa: "Sascar", login: "user", senha: "pass", id_equipamento: "" } },
      },
      stepC: null, stepD: null, stepE: {}, collectedCarretaOwners: [],
    } as unknown as ConfirmationWizardData;

    const rastreador = (buildSubmitDados(data).motorista as Record<string, unknown>).rastreador as Record<string, unknown>;
    expect(rastreador).toEqual({ empresa: "Sascar", login: "user", senha: "pass" });
    expect("id_rastreador" in rastreador).toBe(false);
  });

  it("inclui id_rastreador quando id_equipamento preenchido", () => {
    const data = {
      stepA: baseStepA,
      stepB: {
        placa: "CUD3H59", ownerDoc: "12345678901", ownerDocType: "cpf",
        a6: { possui: "sim", rastreador: { empresa: "Sascar", login: "user", senha: "pass", id_equipamento: "EQ-123" } },
      },
      stepC: null, stepD: null, stepE: {}, collectedCarretaOwners: [],
    } as unknown as ConfirmationWizardData;

    const rastreador = (buildSubmitDados(data).motorista as Record<string, unknown>).rastreador as Record<string, unknown>;
    expect(rastreador.id_rastreador).toBe("EQ-123");
  });
});
