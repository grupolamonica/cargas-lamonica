import { buildDisplayDateTime, formatDateOnly, formatScheduleLabel, formatShortDateTime, parseDisplayDate } from "@/lib/dateDisplay";

describe("dateDisplay", () => {
  it("formats ISO and sheet datetime values without leaking invalid date text", () => {
    expect(formatShortDateTime("2026-04-08T14:35:00")).toBe("08/04 14:35");
    expect(formatShortDateTime("08/04/2026 14:35")).toBe("08/04 14:35");
  });

  it("returns the provided fallback for empty and placeholder values", () => {
    expect(formatShortDateTime("", "A confirmar")).toBe("A confirmar");
    expect(formatShortDateTime("undefined", "A confirmar")).toBe("A confirmar");
    expect(formatShortDateTime("Invalid Date", "A confirmar")).toBe("A confirmar");
  });

  it("builds a valid datetime from separate date and time fields", () => {
    const combinedDate = buildDisplayDateTime("2026-04-08", "8:30:00");

    expect(combinedDate).toBeInstanceOf(Date);
    expect(formatShortDateTime(combinedDate, "A confirmar")).toBe("08/04 08:30");
  });

  it("returns null when the separated schedule fields are malformed", () => {
    expect(buildDisplayDateTime("2026-04-08", "undefined")).toBeNull();
    expect(buildDisplayDateTime("undefined", "08:30")).toBeNull();
    expect(parseDisplayDate("null")).toBeNull();
  });

  it("formats date-only labels safely", () => {
    expect(formatDateOnly("2026-04-08T14:35:00")).toBe("08/04/2026");
    expect(formatDateOnly("invalido", "Base importada")).toBe("Base importada");
  });

  it("não joga datas de calendário para o dia anterior (UTC vs BRT)", () => {
    // A coluna `cargas.data` (date) é serializada pelo backend em container UTC
    // como meia-noite Z. Parsear como instante e formatar em BRT (UTC-3) mostrava
    // o dia anterior — era o que fazia a carga recorrente "parecer" não avançar.
    expect(formatDateOnly("2026-06-22T00:00:00.000Z")).toBe("22/06/2026");
    expect(formatDateOnly("2026-01-01T00:00:00.000Z")).toBe("01/01/2026");
    // Forma date-only crua segue correta.
    expect(formatDateOnly("2026-06-22")).toBe("22/06/2026");
  });

  it("formata rótulo de agenda do datetime-local sem deslocar a hora", () => {
    // Carga manual: valor cru do <input datetime-local> → DD-MM-AAAA HH:mm.
    expect(formatScheduleLabel("2026-07-11T12:00")).toBe("11-07-2026 12:00");
    expect(formatScheduleLabel("2026-07-11T12:00:00")).toBe("11-07-2026 12:00");
    expect(formatScheduleLabel("2026-07-11 08:30")).toBe("11-07-2026 08:30");
  });

  it("preserva rótulos amigáveis da planilha e trata vazio", () => {
    // Planilha: rótulo já legível (não-ISO) volta inalterado.
    expect(formatScheduleLabel("11/07 08:00")).toBe("11/07 08:00");
    expect(formatScheduleLabel("Sexta 08:00")).toBe("Sexta 08:00");
    expect(formatScheduleLabel("", "—")).toBe("—");
    expect(formatScheduleLabel(null, "—")).toBe("—");
    expect(formatScheduleLabel("undefined", "—")).toBe("—");
  });
});
