import {
  buildRouteFacetOptions,
  dateFilterWithMidnight,
  hasCargoDateFilter,
  matchesCargoDateRange,
  normalizeFilterText,
  routeKeyOf,
  toCargoDateRange,
  type CargoDateFilterState,
} from "@/lib/listFilters";
import { buildLoadingDateTime } from "@/lib/estimatedTime";

describe("listFilters", () => {
  it("builds a canonical route key like the Monitor", () => {
    expect(routeKeyOf({ origem: "São Paulo", destino: "Rio" })).toBe("São Paulo → Rio");
    expect(routeKeyOf({ origem: "  A  ", destino: "  B  " })).toBe("A → B");
    expect(routeKeyOf({ origem: "", destino: "" })).toBe("—");
    expect(routeKeyOf({ origem: "A", destino: null })).toBe("A → —");
  });

  it("normalizes accents and case for search", () => {
    expect(normalizeFilterText("São PAULO")).toBe("sao paulo");
    expect(normalizeFilterText("Pédéra")).toBe("pedera");
  });

  it("forces midnight when the date changes, preserves an edited time", () => {
    // Campo vazio + escolhe data → hora atual do navegador vira 00:00.
    expect(dateFilterWithMidnight("", "2026-07-20T13:45")).toBe("2026-07-20T00:00");
    // Muda a data → volta p/ 00:00.
    expect(dateFilterWithMidnight("2026-07-19T08:00", "2026-07-20T09:30")).toBe("2026-07-20T00:00");
    // Mesma data, só o horário mudou → preserva.
    expect(dateFilterWithMidnight("2026-07-20T00:00", "2026-07-20T09:30")).toBe("2026-07-20T09:30");
    // Limpou.
    expect(dateFilterWithMidnight("2026-07-20T00:00", "")).toBe("");
  });

  it("passes everything when no date range is active", () => {
    const range = toCargoDateRange({ carFrom: "", carTo: "", desFrom: "", desTo: "" });
    expect(matchesCargoDateRange("20/07/2026 08:00", "21/07/2026 10:00", range)).toBe(true);
    expect(matchesCargoDateRange(null, null, range)).toBe(true);
  });

  it("filters by carregamento range (dd/MM/yyyy HH:mm values)", () => {
    const state: CargoDateFilterState = { carFrom: "2026-07-20T00:00", carTo: "2026-07-20T23:59", desFrom: "", desTo: "" };
    const range = toCargoDateRange(state);
    expect(matchesCargoDateRange("20/07/2026 08:00", null, range)).toBe(true);
    expect(matchesCargoDateRange("19/07/2026 23:00", null, range)).toBe(false);
    expect(matchesCargoDateRange("21/07/2026 00:30", null, range)).toBe(false);
    // Sem data parseável, mas faixa ativa → excluída (igual ao Monitor).
    expect(matchesCargoDateRange(null, null, range)).toBe(false);
  });

  it("matches a carregamento built from an ISO-with-Z DATE column (Fila regression)", () => {
    // cargas.data chega do backend como ISO com Z (container UTC serializa a
    // coluna DATE). buildLoadingDateTime normaliza o prefixo YYYY-MM-DD; um raw
    // concat viraria "2026-07-11T00:00:00.000Z 08:00:00" (não parseável) e
    // sumiria com a carga sempre que houvesse filtro de carregamento.
    const carregamento = buildLoadingDateTime(null, "2026-07-11T00:00:00.000Z", "08:00:00");
    const inRange = toCargoDateRange({ carFrom: "2026-07-01T00:00", carTo: "2026-07-31T23:59", desFrom: "", desTo: "" });
    expect(matchesCargoDateRange(carregamento, null, inRange)).toBe(true);
    const outOfRange = toCargoDateRange({ carFrom: "2026-08-01T00:00", carTo: "", desFrom: "", desTo: "" });
    expect(matchesCargoDateRange(carregamento, null, outOfRange)).toBe(false);
  });

  it("filters by descarga range independently", () => {
    const range = toCargoDateRange({ carFrom: "", carTo: "", desFrom: "2026-07-22T00:00", desTo: "" });
    expect(matchesCargoDateRange("20/07/2026 08:00", "22/07/2026 06:00", range)).toBe(true);
    expect(matchesCargoDateRange("20/07/2026 08:00", "21/07/2026 06:00", range)).toBe(false);
  });

  it("reports whether any date bound is set", () => {
    expect(hasCargoDateFilter({ carFrom: "", carTo: "", desFrom: "", desTo: "" })).toBe(false);
    expect(hasCargoDateFilter({ carFrom: "2026-07-20T00:00", carTo: "", desFrom: "", desTo: "" })).toBe(true);
  });

  it("builds deduplicated, sorted route options and skips empty routes", () => {
    const items = [
      { origem: "Rio", destino: "SP" },
      { origem: "Bahia", destino: "SP" },
      { origem: "Rio", destino: "SP" }, // duplicata
      { origem: "", destino: "" }, // sem rota → ignorada
    ];
    const options = buildRouteFacetOptions(items, (i) => i);
    expect(options).toEqual([
      { value: "Bahia → SP", label: "Bahia → SP" },
      { value: "Rio → SP", label: "Rio → SP" },
    ]);
  });
});
