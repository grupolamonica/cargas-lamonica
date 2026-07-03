import { describe, it, expect } from "vitest";

import { mapSpxLookupToVigency } from "./spx-vigency-cache.js";

describe("mapSpxLookupToVigency", () => {
  it("retorna null quando o lookup falhou (ok !== true)", () => {
    expect(mapSpxLookupToVigency(null)).toBeNull();
    expect(mapSpxLookupToVigency({ ok: false })).toBeNull();
  });

  it("retorna null quando inconclusivo (placeholder colidiu)", () => {
    expect(mapSpxLookupToVigency({ ok: true, inconclusivo: true, retcode: 271605059 })).toBeNull();
  });

  it("mapeia motorista inativo (retcode 271605004)", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true, inativo: true, retcode: 271605004 });
    expect(v).toMatchObject({ status: "inativo", encontrado: true });
    expect(v.statusText).toMatch(/reativar/i);
    expect(v.details.retcode).toBe(271605004);
  });

  it("bloqueado tem prioridade sobre inativo", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true, inativo: true, bloqueado: true });
    expect(v.status).toBe("bloqueado");
  });

  it("mapeia ativo quando na nossa agência (e não inativo)", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true, na_minha_agencia: true });
    expect(v.status).toBe("ativo");
  });

  it("solicitação em andamento => pendente", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true, request_pendente: true });
    expect(v.status).toBe("pendente");
  });

  it("mapeia outra agência", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true, outra_agencia: true });
    expect(v.status).toBe("outra_agencia");
  });

  it("não encontrado => nao_cadastrado", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: false });
    expect(v).toMatchObject({ status: "nao_cadastrado", encontrado: false });
  });

  it("encontrado sem flag específica => cadastrado", () => {
    const v = mapSpxLookupToVigency({ ok: true, encontrado: true });
    expect(v.status).toBe("cadastrado");
  });
});
