import { describe, expect, it } from "vitest";

import { checkCnhPresentGate } from "./cnh-present-gate.js";

describe("checkCnhPresentGate — motorista precisa do registro da CNH p/ o SPX (271605013)", () => {
  it("bloqueia quando não há CNH nenhuma", () => {
    const r = checkCnhPresentGate({ motorista: { cpf: "11360277692", nome: "X" } });
    expect(r).not.toBeNull();
    expect(r.code).toBe("SPX_CNH_AUSENTE");
    expect(r.blocked_by).toBe("cnh_motorista");
  });

  it("libera com cnh.registro preenchido", () => {
    expect(checkCnhPresentGate({ motorista: { cnh: { registro: "02569534603" } } })).toBeNull();
  });

  it("libera com cnh.numero (alias)", () => {
    expect(checkCnhPresentGate({ motorista: { cnh: { numero: "02569534603" } } })).toBeNull();
  });

  it("libera com cnh_registro no topo do motorista", () => {
    expect(checkCnhPresentGate({ motorista: { cnh_registro: "02569534603" } })).toBeNull();
  });

  it("libera com cnh string direto", () => {
    expect(checkCnhPresentGate({ motorista: { cnh: "02569534603" } })).toBeNull();
  });

  it("libera com dados.cnh (fallback fora do motorista)", () => {
    expect(checkCnhPresentGate({ motorista: { cpf: "1" }, cnh: { registro: "02569534603" } })).toBeNull();
  });

  it("bloqueia quando o registro é vazio/só espaços", () => {
    expect(checkCnhPresentGate({ motorista: { cnh: { registro: "   " } } })).not.toBeNull();
  });

  it("não se aplica sem motorista", () => {
    expect(checkCnhPresentGate({})).toBeNull();
    expect(checkCnhPresentGate(null)).toBeNull();
    expect(checkCnhPresentGate({ motorista: null })).toBeNull();
  });
});
