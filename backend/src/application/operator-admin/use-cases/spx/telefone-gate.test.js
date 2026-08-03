import { describe, expect, it } from "vitest";

import { checkTelefoneGate } from "./telefone-gate.js";

describe("checkTelefoneGate — motorista precisa de DDD + 9 dígitos p/ o SPX", () => {
  it("bloqueia quando o telefone está ausente (caso JEAN)", () => {
    const r = checkTelefoneGate({ motorista: { cpf: "65010833549", nome: "JEAN" } });
    expect(r).not.toBeNull();
    expect(r.code).toBe("SPX_TELEFONE_INVALIDO");
    expect(r.blocked_by).toBe("telefone");
    expect(r.telefone).toBeNull();
  });

  it("bloqueia telefone com 10 dígitos (formato antigo, sem o 9)", () => {
    const r = checkTelefoneGate({ motorista: { telefone: "3833334444" } });
    expect(r).not.toBeNull();
    expect(r.code).toBe("SPX_TELEFONE_INVALIDO");
    expect(r.message).toContain("10 dígitos");
  });

  it("libera telefone com 11 dígitos (DDD + 9)", () => {
    expect(checkTelefoneGate({ motorista: { telefone: "38999990000" } })).toBeNull();
  });

  it("aceita telefone formatado ((38) 99999-0000 = 11 dígitos)", () => {
    expect(checkTelefoneGate({ motorista: { telefone: "(38) 99999-0000" } })).toBeNull();
  });

  it("lê telefones[0] com a mesma prioridade do payload-mapper", () => {
    expect(checkTelefoneGate({ motorista: { telefones: ["71995626565"], telefone: "" } })).toBeNull();
    expect(checkTelefoneGate({ motorista: { telefones: ["7199562656"] } })).not.toBeNull();
  });

  it("usa telefone_primario quando não há telefones[]", () => {
    expect(checkTelefoneGate({ motorista: { telefone_primario: "11987654321" } })).toBeNull();
  });

  it("não se aplica sem motorista", () => {
    expect(checkTelefoneGate({})).toBeNull();
    expect(checkTelefoneGate(null)).toBeNull();
    expect(checkTelefoneGate({ motorista: null })).toBeNull();
  });
});
