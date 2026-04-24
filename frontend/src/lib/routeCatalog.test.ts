import {
  formatRouteCurrency,
  formatRouteDurationHours,
  normalizeRouteLocation,
  parseMoneyInput,
  parseOptionalNumber,
  trimTextOrNull,
} from "@/lib/routeCatalog";

describe("routeCatalog", () => {
  it("normalizes route locations for consistent keys", () => {
    expect(normalizeRouteLocation("  São   Paulo / SP ")).toBe("sao paulo / sp");
  });

  it("parses optional numeric values", () => {
    expect(parseOptionalNumber("12,5")).toBe(12.5);
    expect(parseOptionalNumber("")).toBeNull();
  });

  it("parses money inputs in Brazilian and mixed formats", () => {
    expect(parseMoneyInput("R$ 7.500,50")).toBe(7500.5);
    expect(parseMoneyInput("1250.75")).toBe(1250.75);
  });

  it("formats route currency and duration labels", () => {
    expect(formatRouteCurrency(1450)).toBe("R$ 1.450,00");
    expect(formatRouteDurationHours(12.5)).toBe("12h 30min");
  });

  it("returns trimmed text or null", () => {
    expect(trimTextOrNull("  observacao teste  ")).toBe("observacao teste");
    expect(trimTextOrNull("   ")).toBeNull();
  });
});
