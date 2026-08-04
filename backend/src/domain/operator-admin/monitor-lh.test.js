import { describe, expect, it } from "vitest";

import { lookupByMonitorLh } from "./monitor-lh.js";

describe("lookupByMonitorLh", () => {
  const idx = new Map([
    ["LT0Q8602CPLC1", "shopee"],
    ["B101473490", "nestle"],
    ["VAZIO", ""],
  ]);

  it("casa o LH direto", () => {
    expect(lookupByMonitorLh(idx, "LT0Q8602CPLC1")).toBe("shopee");
  });

  it("ignora espaços em volta", () => {
    expect(lookupByMonitorLh(idx, "  B101473490 ")).toBe("nestle");
  });

  it("casa pela PARTE quando a célula traz vários códigos (Nestlé multi-grupo)", () => {
    expect(lookupByMonitorLh(idx, "B101474063, B101473490")).toBe("nestle");
    expect(lookupByMonitorLh(idx, "B101473490,B101474063")).toBe("nestle");
  });

  it("valor falsy no índice ainda conta como match (distingue de 'sem chave')", () => {
    expect(lookupByMonitorLh(idx, "VAZIO")).toBe("");
    expect(lookupByMonitorLh(idx, "OUTRO, VAZIO")).toBe("");
  });

  it("sem match, LH vazio ou índice vazio/null → null", () => {
    expect(lookupByMonitorLh(idx, "DESCONHECIDO")).toBeNull();
    expect(lookupByMonitorLh(idx, "A, B")).toBeNull();
    expect(lookupByMonitorLh(idx, "")).toBeNull();
    expect(lookupByMonitorLh(new Map(), "LT0Q8602CPLC1")).toBeNull();
    expect(lookupByMonitorLh(null, "LT0Q8602CPLC1")).toBeNull();
  });
});
