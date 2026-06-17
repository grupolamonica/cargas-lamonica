import { describe, it, expect } from "vitest";

import { getSaoPauloWallClock } from "./sao-paulo-time.js";

// America/Sao_Paulo é UTC-3 o ano todo (sem horário de verão desde 2019), então
// os offsets abaixo são determinísticos independente de quando o teste roda.
describe("getSaoPauloWallClock", () => {
  it("converte um instante UTC para a hora de parede em Sao Paulo (UTC-3)", () => {
    // 17:00Z => 14:00 em Sao Paulo, mesma data.
    const { dateIso, timeIso } = getSaoPauloWallClock(new Date("2026-06-17T17:00:00Z"));
    expect(dateIso).toBe("2026-06-17");
    expect(timeIso).toBe("14:00:00");
  });

  it("NÃO adianta a data quando o UTC já virou mas em Sao Paulo ainda é o mesmo dia", () => {
    // 02:30Z do dia 18 => 23:30 do dia 17 em Sao Paulo.
    // Este é exatamente o bug: usar a data UTC (18) escondia o dia inteiro de
    // cargas de hoje (17) para o motorista depois das 21h BRT.
    const instant = new Date("2026-06-18T02:30:00Z");
    const { dateIso, timeIso } = getSaoPauloWallClock(instant);
    expect(dateIso).toBe("2026-06-17");
    expect(timeIso).toBe("23:30:00");
    // Contraste com o cálculo ingênuo que causava o bug:
    expect(instant.toISOString().slice(0, 10)).toBe("2026-06-18");
  });

  it("lida com a meia-noite de Sao Paulo (hora 00, não 24)", () => {
    // 03:30Z => 00:30 em Sao Paulo, já no dia seguinte.
    const { dateIso, timeIso } = getSaoPauloWallClock(new Date("2026-06-18T03:30:00Z"));
    expect(dateIso).toBe("2026-06-18");
    expect(timeIso).toBe("00:30:00");
  });

  it("retorna strings no formato esperado pelos filtros (YYYY-MM-DD / HH:MM:SS)", () => {
    const { dateIso, timeIso } = getSaoPauloWallClock(new Date("2026-01-05T12:00:00Z"));
    expect(dateIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(timeIso).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
