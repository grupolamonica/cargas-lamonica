import { describe, it, expect } from "vitest";

import { computeNextRecurrenceDate } from "./advance-recurring-cargas.js";

// Referência fixa: 2026-06-17 (quarta) ao MEIO-DIA local. Meio-dia evita que o
// offset de fuso empurre a data de `toISOString()` para outro dia, mantendo o
// teste determinístico tanto no CI (UTC) quanto local (America/Sao_Paulo).
const NOW = new Date(2026, 5, 17, 12, 0, 0);

describe("computeNextRecurrenceDate", () => {
  it("mantém a data quando a ocorrência de hoje ainda está no futuro", () => {
    expect(computeNextRecurrenceDate("2026-06-17", "18:00:00", 1, NOW)).toBe("2026-06-17");
  });

  it("mantém a data quando o horário é exatamente agora (>= agora é visível)", () => {
    expect(computeNextRecurrenceDate("2026-06-17", "12:00:00", 1, NOW)).toBe("2026-06-17");
  });

  it("avança 1 dia (diária) quando o horário de hoje já passou", () => {
    expect(computeNextRecurrenceDate("2026-06-17", "04:00:00", 1, NOW)).toBe("2026-06-18");
  });

  it("avança a partir de uma data no passado até a próxima ocorrência visível", () => {
    // 15 (passado) -> 16 (passado) -> 17 (hoje, 09:00 < 12:00 não visível) -> 18
    expect(computeNextRecurrenceDate("2026-06-15", "09:00:00", 1, NOW)).toBe("2026-06-18");
  });

  it("respeita o intervalo configurável (a cada 7 dias) e mantém a cadência", () => {
    // 10 -> 17 (hoje, 08:00 < 12:00 não visível) -> 24
    expect(computeNextRecurrenceDate("2026-06-10", "08:00:00", 7, NOW)).toBe("2026-06-24");
  });

  it("mantém a data quando já está no futuro (não mexe)", () => {
    expect(computeNextRecurrenceDate("2026-06-20", "08:00:00", 1, NOW)).toBe("2026-06-20");
  });

  it("trata intervalo inválido (0, NaN, negativo) como diário", () => {
    expect(computeNextRecurrenceDate("2026-06-17", "04:00:00", 0, NOW)).toBe("2026-06-18");
    expect(computeNextRecurrenceDate("2026-06-17", "04:00:00", Number.NaN, NOW)).toBe("2026-06-18");
    expect(computeNextRecurrenceDate("2026-06-17", "04:00:00", -3, NOW)).toBe("2026-06-18");
  });

  it("aceita horário sem segundos (HH:MM)", () => {
    expect(computeNextRecurrenceDate("2026-06-17", "04:00", 1, NOW)).toBe("2026-06-18");
    expect(computeNextRecurrenceDate("2026-06-17", "18:00", 1, NOW)).toBe("2026-06-17");
  });

  it("cruza a virada de mês corretamente", () => {
    const endOfMonth = new Date(2026, 5, 30, 12, 0, 0); // 2026-06-30 meio-dia
    expect(computeNextRecurrenceDate("2026-06-30", "04:00:00", 1, endOfMonth)).toBe("2026-07-01");
  });
});
