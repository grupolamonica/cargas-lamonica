import { describe, it, expect } from "vitest";

import { resolveWindow } from "./driver-flow-metrics.js";

const DAY_MS = 86_400_000;

describe("resolveWindow (DC-241 — filtro de período)", () => {
  it("sem parâmetros: janela curta padrão (~7 dias), não é todo o período", () => {
    const w = resolveWindow({});
    expect(w.allTime).toBe(false);
    const spanDays = Math.round((w.dateToExclusive.getTime() - w.dateFrom.getTime()) / DAY_MS);
    // Default de 7 dias (com o dia final exclusivo já existente no código = 7~8).
    expect(spanDays).toBeGreaterThanOrEqual(7);
    expect(spanDays).toBeLessThanOrEqual(8);
  });

  it("range=all: abre todo o período (piso 2000) e marca allTime, sem cair no teto de 365d", () => {
    const w = resolveWindow({ range: "all" });
    expect(w.allTime).toBe(true);
    expect(w.dateFrom.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    const spanDays = Math.round((w.dateToExclusive.getTime() - w.dateFrom.getTime()) / DAY_MS);
    // Muito além do teto de 365 dias — o all-time NÃO deve ser clampado.
    expect(spanDays).toBeGreaterThan(365);
  });

  it("range=ALL é case-insensitive", () => {
    expect(resolveWindow({ range: "ALL" }).allTime).toBe(true);
  });

  it("datas explícitas: usa a janela informada [from, toExclusive)", () => {
    const w = resolveWindow({ dateFrom: "2026-07-01", dateTo: "2026-07-07" });
    expect(w.allTime).toBe(false);
    // 01/07 00:00 BRT (03:00Z) até 08/07 00:00 BRT (exclusivo) = 7 dias.
    const spanDays = Math.round((w.dateToExclusive.getTime() - w.dateFrom.getTime()) / DAY_MS);
    expect(spanDays).toBe(7);
    expect(w.dateFrom.toISOString()).toBe("2026-07-01T03:00:00.000Z");
  });

  it("janela absurdamente grande por datas é clampada em 365 dias (não é all-time)", () => {
    const w = resolveWindow({ dateFrom: "2000-01-01", dateTo: "2026-01-01" });
    expect(w.allTime).toBe(false);
    const spanDays = Math.round((w.dateToExclusive.getTime() - w.dateFrom.getTime()) / DAY_MS);
    expect(spanDays).toBe(365);
  });
});
