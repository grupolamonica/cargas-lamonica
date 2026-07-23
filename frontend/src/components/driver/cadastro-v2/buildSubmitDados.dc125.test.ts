import { describe, expect, it } from "vitest";

import { buildSubmitDados } from "./buildSubmitDados";
import type { ConfirmationWizardData } from "./ConfirmationScreen";

// DC-125 — fluxo SEM LOGIN com Step A pulado (motorista já conhecido).
// buildMotorista retorna null; precisamos emitir `motorista: { cpf }` para o
// backend hidratar o motorista persistido por CPF (senão 422 motorista vazio).

const baseSkippedStepA = (cpf?: string): ConfirmationWizardData => ({
  stepA: null,
  stepB: null,
  stepC: null,
  stepD: null,
  stepE: {},
  collectedCarretaOwners: [],
  horsePlate: "NLN8428",
  cpf,
});

describe("buildSubmitDados / DC-125 motorista partial", () => {
  it("emite motorista { cpf } quando Step A foi pulado e há CPF do pré-check", () => {
    const dados = buildSubmitDados(baseSkippedStepA("019.724.126-39"));
    expect(dados.motorista).toEqual({ cpf: "01972412639" });
  });

  it("omite motorista quando Step A pulado e não há CPF (comportamento anterior)", () => {
    const dados = buildSubmitDados(baseSkippedStepA(undefined));
    expect(dados.motorista).toBeUndefined();
  });

  it("ainda emite cavalo partial { placa } a partir de horsePlate", () => {
    const dados = buildSubmitDados(baseSkippedStepA("01972412639"));
    expect(dados.cavalo).toEqual({ placa: "NLN8428" });
  });
});

// Fix do 422 "Payload invalido": o backend exige
// cavalo_owner.endereco.comprovante_storage_path p/ proprietário PF, mas o
// endereço/comprovante coletado em stepC.ownerEndereco não era mapeado.
describe("buildSubmitDados / endereço+comprovante do proprietário", () => {
  const withPfOwner = (): ConfirmationWizardData =>
    ({
      stepA: null,
      stepB: { ownerIsDriver: false },
      stepC: {
        owner: { documento: "77594100697", nome: "NILTON DIAS DE SOUZA", docType: "cpf" },
        ownerEndereco: {
          cep: "39404-643",
          numero: "194",
          logradouro: "Rua Clemente Barbosa",
          bairro: "Santa Laura",
          cidade: "Montes Claros",
          uf: "MG",
          comprovanteUrl: "06658670692/x/cavalo_owner_comprovante.jpg",
        },
      },
      stepD: null,
      stepE: {},
      collectedCarretaOwners: [],
      horsePlate: "DYC7B43",
      cpf: "06658670692",
    }) as unknown as ConfirmationWizardData;

  it("mapeia ownerEndereco → cavalo_owner.endereco.comprovante_storage_path (PF)", () => {
    const dados = buildSubmitDados(withPfOwner()) as {
      cavalo_owner?: { tipo?: string; endereco?: { comprovante_storage_path?: string; cep?: string } };
    };
    expect(dados.cavalo_owner?.tipo).toBe("pf");
    expect(dados.cavalo_owner?.endereco?.cep).toBe("39404-643");
    expect(dados.cavalo_owner?.endereco?.comprovante_storage_path).toBe(
      "06658670692/x/cavalo_owner_comprovante.jpg",
    );
  });

  it("omite endereco quando o proprietário não tem endereço completo", () => {
    const data = withPfOwner();
    (data.stepC as unknown as { ownerEndereco?: unknown }).ownerEndereco = { comprovanteUrl: "so/comprovante.jpg" };
    const dados = buildSubmitDados(data) as { cavalo_owner?: { endereco?: unknown } };
    expect(dados.cavalo_owner?.endereco).toBeUndefined();
  });
});
