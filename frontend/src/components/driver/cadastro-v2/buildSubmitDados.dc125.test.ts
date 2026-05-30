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
