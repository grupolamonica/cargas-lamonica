import { describe, it, expect } from "vitest";

import { dedupeSystemRowsByLh } from "./dedupe-monitor-rows.js";

describe("dedupeSystemRowsByLh", () => {
  it("remove a carga do sistema cujo LH colide com uma linha da planilha", () => {
    const sheet = [{ lh: "LT1Q7F02BD5N1" }, { lh: "LT-OUTRA" }];
    const system = [{ lh: "LT1Q7F02BD5N1", cargoId: "c1" }, { lh: "SISTEMA-UNICA", cargoId: "c2" }];
    const { rows, dropped } = dedupeSystemRowsByLh(sheet, system);
    expect(dropped).toBe(1);
    expect(rows.map((r) => r.lh)).toEqual(["SISTEMA-UNICA"]);
  });

  it("mantém cargas do sistema sem colisão", () => {
    const sheet = [{ lh: "A" }, { lh: "B" }];
    const system = [{ lh: "C" }, { lh: "D" }];
    const { rows, dropped } = dedupeSystemRowsByLh(sheet, system);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it("ignora espaços em volta do LH ao comparar", () => {
    const sheet = [{ lh: " LT-X " }];
    const system = [{ lh: "LT-X" }];
    const { rows, dropped } = dedupeSystemRowsByLh(sheet, system);
    expect(dropped).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it("nunca dropa carga do sistema SEM LH (lh vazio não casa)", () => {
    const sheet = [{ lh: "" }, { lh: "A" }];
    const system = [{ lh: "" }, { lh: "" }];
    const { rows, dropped } = dedupeSystemRowsByLh(sheet, system);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it("não muta os arrays de entrada", () => {
    const sheet = [{ lh: "A" }];
    const system = [{ lh: "A" }, { lh: "B" }];
    dedupeSystemRowsByLh(sheet, system);
    expect(system).toHaveLength(2);
  });
});
