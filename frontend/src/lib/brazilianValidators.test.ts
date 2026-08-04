import { describe, expect, it } from "vitest";

import { isValidBrazilianMobile, isValidBrazilianPhone, isValidPis } from "./brazilianValidators";

describe("isValidBrazilianMobile — celular estrito (DDD + 9 dígitos = 11)", () => {
  it("aceita celular de 11 dígitos com DDD válido e 9", () => {
    expect(isValidBrazilianMobile("11987654321")).toBe(true);
    expect(isValidBrazilianMobile("(38) 99999-0000")).toBe(true);
  });

  it("REJEITA fixo de 10 dígitos (o que o isValidBrazilianPhone deixava passar)", () => {
    expect(isValidBrazilianPhone("3833334444")).toBe(true); // leniente
    expect(isValidBrazilianMobile("3833334444")).toBe(false); // estrito
  });

  it("rejeita 11 dígitos sem o 9 na posição de celular", () => {
    expect(isValidBrazilianMobile("11887654321")).toBe(false);
  });

  it("rejeita DDD inválido", () => {
    expect(isValidBrazilianMobile("00987654321")).toBe(false);
  });

  it("rejeita vazio/curto/nulo", () => {
    expect(isValidBrazilianMobile("")).toBe(false);
    expect(isValidBrazilianMobile("9998888")).toBe(false);
    expect(isValidBrazilianMobile(null)).toBe(false);
  });
});

describe("isValidPis — 11 dígitos + dígito verificador (mod 11)", () => {
  it("aceita PIS válido (com e sem máscara)", () => {
    expect(isValidPis("12345678900")).toBe(true); // dv calculado = 0
    expect(isValidPis("120.6082.844-0")).toBe(true); // mesmo número, formatado (dv=0)
  });

  it("rejeita dígito verificador errado", () => {
    expect(isValidPis("12345678901")).toBe(false);
  });

  it("rejeita comprimento != 11 e repetidos", () => {
    expect(isValidPis("1234567890")).toBe(false);
    expect(isValidPis("00000000000")).toBe(false);
    expect(isValidPis("")).toBe(false);
    expect(isValidPis(null)).toBe(false);
  });
});
