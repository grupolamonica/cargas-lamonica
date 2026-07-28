import { describe, it, expect } from "vitest";

import {
  normalizeRouteCodeLocation,
  canonicalizeRouteLookupLocation,
} from "./route-utils.js";

describe("normalizeRouteCodeLocation — chave do CÓDIGO de rota (só variações de formato)", () => {
  it("dobra o MESMO local escrito diferente (planilha vs sistema vs sem UF) na mesma chave", () => {
    const alvo = "simoes filho";
    expect(normalizeRouteCodeLocation("Simoes Filho / BA")).toBe(alvo); // planilha (espaços na barra)
    expect(normalizeRouteCodeLocation("Simoes Filho/BA")).toBe(alvo); // sistema (sem espaços)
    expect(normalizeRouteCodeLocation("Simões Filho")).toBe(alvo); // sem UF, com acento
    expect(normalizeRouteCodeLocation("SIMÕES FILHO/BA")).toBe(alvo); // caixa alta
  });

  it("aplica o mesmo em destino (Jaboatão) — resolve o exemplo rota 1 vs 188", () => {
    const alvo = "jaboatao dos guararapes";
    expect(normalizeRouteCodeLocation("Jaboatão dos Guararapes / PE")).toBe(alvo);
    expect(normalizeRouteCodeLocation("Jaboatão dos Guararapes/PE")).toBe(alvo);
  });

  it("remove sufixo operacional (-03) mas mantém o nome do sub-local", () => {
    expect(normalizeRouteCodeLocation("SJ Rio Preto-03")).toBe("sj rio preto");
    expect(normalizeRouteCodeLocation("Sao Paulo-02")).toBe("sao paulo");
  });

  it("MANTÉM sub-locais distintos separados (Pirajá ≠ Retiro ≠ Salvador) — NÃO usa apelidos", () => {
    const piraja = normalizeRouteCodeLocation("Salvador Pirajá / BA");
    const retiro = normalizeRouteCodeLocation("Salvador Retiro / BA");
    const salvador = normalizeRouteCodeLocation("Salvador / BA");
    expect(piraja).toBe("salvador piraja");
    expect(retiro).toBe("salvador retiro");
    expect(salvador).toBe("salvador");
    expect(new Set([piraja, retiro, salvador]).size).toBe(3); // três chaves distintas
  });

  it("contraste: a canonicalização do PREÇO (com apelidos) fundiria os três em 'salvador'", () => {
    expect(canonicalizeRouteLookupLocation("Salvador Pirajá / BA")).toBe("salvador");
    expect(canonicalizeRouteLookupLocation("Salvador Retiro / BA")).toBe("salvador");
    // Prova de que o código de rota (conservador) preserva a distinção que o preço não faz.
    expect(normalizeRouteCodeLocation("Salvador Pirajá / BA")).not.toBe(
      normalizeRouteCodeLocation("Salvador Retiro / BA"),
    );
  });

  it("nulo/vazio → string vazia (nunca quebra)", () => {
    expect(normalizeRouteCodeLocation(null)).toBe("");
    expect(normalizeRouteCodeLocation(undefined)).toBe("");
    expect(normalizeRouteCodeLocation("   ")).toBe("");
  });
});
