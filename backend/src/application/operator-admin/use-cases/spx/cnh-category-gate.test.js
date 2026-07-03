import { describe, expect, it } from "vitest";

import { checkCnhCategoryGate } from "./cnh-category-gate.js";

function dados({ categoria, cavalo = "NLN8428", carreta } = {}) {
  const d = {
    motorista: {
      nome: "FULANO DE TAL", cpf: "019.724.126-39",
      cnh: { registro: "06537742154", categoria, validade: "2035-07-21" },
    },
  };
  if (cavalo) d.cavalo = { placa: cavalo, renavam: "00268719179" };
  if (carreta) d.carreta = { placa: carreta, renavam: "00111111111" };
  return d;
}

describe("checkCnhCategoryGate — cavalo/carreta exige CNH com E", () => {
  it("AB com cavalo → BLOQUEIA com mensagem clara (caso NILTON)", () => {
    const r = checkCnhCategoryGate(dados({ categoria: "AB" }));
    expect(r).not.toBeNull();
    expect(r.blocked_by).toBe("cnh_category");
    expect(r.categoria).toBe("AB");
    expect(r.message).toContain("categoria AB");
    expect(r.message).toContain("cavalo");
    expect(r.message).toContain("E (AE/BE/CE/DE/E)");
  });

  it("D com cavalo → BLOQUEIA (D não tem E)", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "D" }))).not.toBeNull();
  });

  it("AE com cavalo → OK (tem E)", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "AE" }))).toBeNull();
  });

  it("E sozinha com cavalo → OK", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "E" }))).toBeNull();
  });

  it("CE com cavalo+carreta → OK", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "CE", carreta: "ABC1234" }))).toBeNull();
  });

  it("C com cavalo+carreta → BLOQUEIA com alvo 'cavalo+carreta'", () => {
    const r = checkCnhCategoryGate(dados({ categoria: "C", carreta: "ABC1234" }));
    expect(r).not.toBeNull();
    expect(r.message).toContain("cavalo+carreta");
  });

  it("sem veículo → não bloqueia (gate não se aplica)", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "B", cavalo: null }))).toBeNull();
  });

  it("categoria vazia → não bloqueia (deixa o SPX validar pela imagem)", () => {
    expect(checkCnhCategoryGate(dados({ categoria: "" }))).toBeNull();
  });
});
