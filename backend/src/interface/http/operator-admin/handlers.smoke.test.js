import { describe, expect, it } from "vitest";

// Importa o módulo REAL de handlers (sem mocks). Se qualquer named import da
// cadeia estiver quebrado — ex.: um use-case novo não re-exportado por
// service.js — este import lança um SyntaxError de ESM e o teste falha.
//
// Guarda contra o incidente 2026-07-11: fetchCargoHistoryByLh foi importado em
// handlers.js mas não re-exportado em service.js; build + testes passaram, mas
// o backend quebrava no BOOT em produção (404). Este smoke test cobre o gap.
import * as handlers from "./handlers.js";

describe("operator-admin handlers — módulo carrega (guarda de boot)", () => {
  it("expõe os handlers HTTP (cadeia de imports íntegra)", () => {
    expect(typeof handlers.resolveCargoHistoryResponse).toBe("function");
    expect(typeof handlers.resolveLookupCargoByCodigoViagemResponse).toBe("function");
    expect(typeof handlers.resolveCreateOperatorCargoResponse).toBe("function");
  });
});
