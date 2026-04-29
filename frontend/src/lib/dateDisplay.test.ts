import {
  buildDisplayDateTime,
  formatDateOnly,
  formatShortDateTime,
  normalizeDateInputValue,
  parseDisplayDate,
} from "@/lib/dateDisplay";

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

  it("normalizes OCR date strings for input[type=date] even with extra text", () => {
    expect(normalizeDateInputValue("31/03/2026")).toBe("2026-03-31");
    expect(normalizeDateInputValue("31/03/2026 DIGITALMENTE PELO DETRAN")).toBe("2026-03-31");
    expect(normalizeDateInputValue("DATA\n31/03/2026")).toBe("2026-03-31");
    expect(normalizeDateInputValue("25/7/2025")).toBe("2025-07-25");
  });

  it("does not fabricate day and month when only the year is available", () => {
    expect(normalizeDateInputValue("2025")).toBe("");
    expect(normalizeDateInputValue("ano_exercicio 2025")).toBe("");
  });
});
