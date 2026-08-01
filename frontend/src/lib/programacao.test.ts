import { describe, expect, it } from "vitest";

import { isHiddenLatePlanejado } from "@/lib/programacao";

const NOW = Date.UTC(2026, 7, 1, 12, 0); // 01/08/2026 12:00 UTC
const PASSADO = Math.floor(Date.UTC(2026, 7, 1, 9, 0) / 1000);
const FUTURO = Math.floor(Date.UTC(2026, 7, 1, 18, 0) / 1000);

const row = (over: Partial<Parameters<typeof isHiddenLatePlanejado>[0]> = {}) => ({
  tab: "planejado" as const,
  carregamentoTs: PASSADO,
  motorista: "",
  ...over,
});

describe("isHiddenLatePlanejado", () => {
  it("esconde atrasada SEM motorista (backlog morto do Planejado)", () => {
    expect(isHiddenLatePlanejado(row(), NOW)).toBe(true);
  });

  it("MANTÉM atrasada COM motorista (não existe outra aba p/ ela)", () => {
    expect(isHiddenLatePlanejado(row({ motorista: "UBIRAJARA DOS SANTOS" }), NOW)).toBe(false);
    // espaço em branco não conta como motorista
    expect(isHiddenLatePlanejado(row({ motorista: "   " }), NOW)).toBe(true);
  });

  it("não esconde viagem futura", () => {
    expect(isHiddenLatePlanejado(row({ carregamentoTs: FUTURO }), NOW)).toBe(false);
  });

  it("nunca esconde linha sem carregamentoTs (na dúvida, mostrar)", () => {
    expect(isHiddenLatePlanejado(row({ carregamentoTs: null }), NOW)).toBe(false);
  });

  it("só age na aba Planejado (Aceito/Concluído são naturalmente passados)", () => {
    expect(isHiddenLatePlanejado(row({ tab: "aceito" }), NOW)).toBe(false);
    expect(isHiddenLatePlanejado(row({ tab: "concluido" }), NOW)).toBe(false);
  });
});
