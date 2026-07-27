import { describe, expect, it } from "vitest";

import { buildSubmitDados } from "./buildSubmitDados";
import type { ConfirmationWizardData } from "./ConfirmationScreen";

// FASE 3 (Rodopar) — os campos complementares do motorista coletados no card A4
// devem sair em `dados.motorista` (sexo/estado_civil/cor_raca/pis/rg_data/
// dados_bancarios), com o banco mapeado igual ao titular ANTT.

function stepAWithA4(a4: Record<string, unknown>): ConfirmationWizardData {
  return {
    stepA: {
      a1: { nome: "VICTOR DE OLIVEIRA MOREIRA", cpf: "072.813.433-02" },
      a1b: { fileName: "selfie.jpg" },
      a2: { telefones: ["88981411853"], telefone_primario: "88981411853" },
      a3: { cep: "62960-000", numero: "136", logradouro: "RUA X", cidade: "TABULEIRO DO NORTE", uf: "CE" },
      a4,
    },
    stepB: null,
    stepC: null,
    stepD: null,
    stepE: {},
    collectedCarretaOwners: [],
    horsePlate: "ABC1D23",
  } as unknown as ConfirmationWizardData;
}

describe("buildSubmitDados / A4 dados complementares (Rodopar)", () => {
  it("emite sexo/estado_civil/cor_raca/pis/rg_data/dados_bancarios no motorista", () => {
    const dados = buildSubmitDados(
      stepAWithA4({
        sexo: "masculino",
        estado_civil: "casado",
        cor_raca: "branca",
        pis: "12419711434",
        rg_data: "2016-08-10",
        banco: {
          bank: { compe: "341", nome: "Itaú Unibanco", ispb: "60701190" },
          agencia: "3123",
          conta: "23",
          tipo: "corrente",
        },
      }),
    );
    const m = dados.motorista as Record<string, unknown>;
    expect(m.sexo).toBe("masculino");
    expect(m.estado_civil).toBe("casado");
    expect(m.cor_raca).toBe("branca");
    expect(m.pis).toBe("12419711434");
    expect(m.rg_data).toBe("2016-08-10");
    expect(m.dados_bancarios).toEqual({
      banco_compe: "341",
      banco_nome: "Itaú Unibanco",
      agencia: "3123",
      conta: "23",
      tipo: "corrente",
    });
  });

  it("omite dados_bancarios quando o banco está incompleto", () => {
    const dados = buildSubmitDados(
      stepAWithA4({
        sexo: "feminino",
        banco: { bank: null, agencia: "", conta: "", tipo: "" },
      }),
    );
    const m = dados.motorista as Record<string, unknown>;
    expect(m.sexo).toBe("feminino");
    expect(m.dados_bancarios).toBeUndefined();
  });

  it("não emite os campos A4 quando ausentes (backward-compat)", () => {
    const dados = buildSubmitDados(stepAWithA4({}));
    const m = dados.motorista as Record<string, unknown>;
    expect(m.sexo).toBeUndefined();
    expect(m.pis).toBeUndefined();
    expect(m.dados_bancarios).toBeUndefined();
  });
});
