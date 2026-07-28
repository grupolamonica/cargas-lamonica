import { describe, expect, it } from "vitest";

import { buildSubmitDados } from "./buildSubmitDados";
import type { ConfirmationWizardData } from "./ConfirmationScreen";

// Regressão do dedup de carreta_owners (BUG-WALK-08) no caso ownerIsDriver:
// quando o motorista é o dono do cavalo, o Step C é pulado (stepC=null). O
// fallback antigo (data.stepC?.owner.documento) virava "" e a carreta cujo dono
// é o PRÓPRIO motorista NÃO era deduplicada — o CPF do motorista (que já é
// cavalo.owner_doc) duplicava em carreta_owners. O fix usa stepB.ownerDoc quando
// ownerIsDriver.

const DRIVER_CPF = "11144477735";

function baseData(): ConfirmationWizardData {
  return {
    stepA: null,
    stepB: {
      placa: "ABC1D23",
      renavam: "111",
      chassi: "9BW1",
      marca: "SCANIA",
      ano: "2020",
      cor: "BRANCA",
      ownerDoc: DRIVER_CPF,
      ownerDocType: "cpf",
      ownerNome: "JOSE MOTORISTA",
      ownerIsDriver: true, // Step C pulado
    },
    stepC: null,
    stepD: {
      carretas: [
        {
          plate: "CAR1A11",
          renavam: "222",
          owner_doc: DRIVER_CPF,
          owner_resolution: "reused_cavalo",
        },
      ],
    },
    stepE: {},
    collectedCarretaOwners: [
      // dono da carreta == o próprio motorista (mesmo doc do cavalo)
      { doc: DRIVER_CPF, docType: "cpf", pfData: { telefone: "11999999999" } },
    ],
    horsePlate: "ABC1D23",
    cpf: DRIVER_CPF,
  } as unknown as ConfirmationWizardData;
}

describe("buildSubmitDados — dedup de carreta_owners com ownerIsDriver", () => {
  it("NÃO duplica o CPF do motorista em carreta_owners (dono == cavalo_owner)", () => {
    const dados = buildSubmitDados(baseData());
    // carreta_owners só deve conter donos DISTINTOS do dono do cavalo.
    // Como o único dono coletado é o próprio motorista, o array fica vazio
    // (omitido do payload).
    expect(dados.carreta_owners).toBeUndefined();
  });

  it("ainda inclui um dono de carreta DISTINTO do motorista", () => {
    const data = baseData();
    (data.collectedCarretaOwners as Array<{ doc: string; docType: string; pfData?: unknown }>).push(
      { doc: "22233344455", docType: "cpf", pfData: { telefone: "11888888888" } },
    );
    const dados = buildSubmitDados(data) as { carreta_owners?: unknown[] };
    // o motorista é deduplicado; o dono distinto permanece → exatamente 1.
    expect(Array.isArray(dados.carreta_owners)).toBe(true);
    expect(dados.carreta_owners).toHaveLength(1);
  });
});
