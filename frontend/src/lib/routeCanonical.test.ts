import { describe, it, expect } from "vitest";

import { routeCanonKey, normalizeRouteCodeLocation } from "@/lib/routeCanonical";

describe("routeCanonKey — mesma rota em formatos diferentes casa (fix do arrastar entre formatos)", () => {
  it("planilha 'Cidade / UF' e sistema 'Cidade/UF' e 'CIDADE' → MESMA chave", () => {
    const planilha = routeCanonKey("Simoes Filho / BA", "Jaboatão dos Guararapes / PE");
    const sistema = routeCanonKey("Simoes Filho/BA", "Jaboatão dos Guararapes/PE");
    const semUf = routeCanonKey("SIMÕES FILHO", "JABOATAO DOS GUARARAPES");
    expect(planilha).toBe(sistema);
    expect(planilha).toBe(semUf);
    expect(new Set([planilha, sistema, semUf]).size).toBe(1); // uma rota só
  });

  it("sufixo operacional '-03' não separa a rota", () => {
    expect(routeCanonKey("SJ Rio Preto-03", "Cabo")).toBe(routeCanonKey("SJ Rio Preto", "Cabo"));
  });

  it("sub-locais distintos permanecem SEPARADOS (Pirajá ≠ Retiro ≠ Salvador)", () => {
    const piraja = routeCanonKey("Simoes Filho/BA", "Salvador Pirajá / BA");
    const retiro = routeCanonKey("Simoes Filho/BA", "Salvador Retiro / BA");
    const salvador = routeCanonKey("Simoes Filho/BA", "Salvador / BA");
    expect(new Set([piraja, retiro, salvador]).size).toBe(3);
  });

  it("rotas realmente diferentes NÃO casam (guarda continua válida)", () => {
    expect(routeCanonKey("Simoes Filho/BA", "Recife/PE")).not.toBe(
      routeCanonKey("Feira de Santana/BA", "Recife/PE"),
    );
  });

  it("normalizeRouteCodeLocation: acento/caixa/UF/espaço", () => {
    expect(normalizeRouteCodeLocation("Simões Filho / BA")).toBe("simoes filho");
    expect(normalizeRouteCodeLocation("SIMOES FILHO/BA")).toBe("simoes filho");
    expect(normalizeRouteCodeLocation(null)).toBe("");
  });
});
