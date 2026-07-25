import { describe, it, expect } from "vitest";

import { isStatusTextConforme } from "./conformidade.js";

// Espelha a regra do robô Angellira (_detectar_situacao_por_descricao): só
// "Conforme" conta; "Não Conforme" (superstring), homologadora e vazio ⇒ false.
describe("isStatusTextConforme", () => {
  it("aceita 'Conforme' em variações de caixa/acentuação/espaço", () => {
    expect(isStatusTextConforme("Conforme")).toBe(true);
    expect(isStatusTextConforme("CONFORME")).toBe(true);
    expect(isStatusTextConforme("  conforme  ")).toBe(true);
    expect(isStatusTextConforme("Conforme ✓")).toBe(true);
  });

  it("rejeita 'Não Conforme' (checa NAOCONFORME antes, é superstring)", () => {
    expect(isStatusTextConforme("Não Conforme")).toBe(false);
    expect(isStatusTextConforme("NÃO CONFORME")).toBe(false);
    expect(isStatusTextConforme("nao conforme")).toBe(false);
    expect(isStatusTextConforme("Não-Conforme")).toBe(false);
  });

  it("rejeita homologadora / em análise / atualizando / outros rótulos", () => {
    expect(isStatusTextConforme("Homologadora")).toBe(false);
    expect(isStatusTextConforme("Aguardando homologadora")).toBe(false);
    expect(isStatusTextConforme("Em análise")).toBe(false);
    expect(isStatusTextConforme("Atualizando")).toBe(false);
    expect(isStatusTextConforme("Vencido")).toBe(false);
  });

  it("rejeita vazio/null/undefined", () => {
    expect(isStatusTextConforme("")).toBe(false);
    expect(isStatusTextConforme(null)).toBe(false);
    expect(isStatusTextConforme(undefined)).toBe(false);
    expect(isStatusTextConforme("   ")).toBe(false);
  });
});
