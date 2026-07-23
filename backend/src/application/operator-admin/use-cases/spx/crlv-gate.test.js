import { describe, expect, it } from "vitest";

import { checkCrlvGate } from "./crlv-gate.js";

describe("checkCrlvGate — cavalo com placa exige CRLV anexada (DC-304)", () => {
  it("placa presente mas SEM crlv_url → BLOQUEIA com mensagem acionável", () => {
    const r = checkCrlvGate({ cavalo: { placa: "nln8428" } });
    expect(r).not.toBeNull();
    expect(r.code).toBe("SPX_CRLV_CAVALO_AUSENTE");
    expect(r.blocked_by).toBe("crlv_cavalo");
    expect(r.placa).toBe("NLN8428"); // uppercased
    expect(r.message).toContain("NLN8428");
    expect(r.message).toContain("CRLV");
    expect(r.acao).toMatch(/anexe a crlv/i);
  });

  it("placa + crlv_url presentes → não bloqueia", () => {
    expect(checkCrlvGate({ cavalo: { placa: "NLN8428", crlv_url: "p/cavalo_crlv.jpg" } })).toBeNull();
  });

  it("sem cavalo (só motorista, sem placa) → não se aplica", () => {
    expect(checkCrlvGate({ motorista: { cpf: "12345678901" } })).toBeNull();
    expect(checkCrlvGate({ cavalo: {} })).toBeNull();
    expect(checkCrlvGate({})).toBeNull();
    expect(checkCrlvGate(null)).toBeNull();
  });

  it("crlv_url vazio/espaços conta como ausente → bloqueia", () => {
    expect(checkCrlvGate({ cavalo: { placa: "ABC1D23", crlv_url: "   " } })).not.toBeNull();
  });
});
