import { describe, it, expect } from "vitest";

import { dedupeSystemRowsByLh, reconcileMonitorDuplicates } from "./dedupe-monitor-rows.js";

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

describe("reconcileMonitorDuplicates — spot lançado vence linha vazia da planilha", () => {
  it("planilha SEM motorista + spot lançado (OPEN) → esconde a planilha, mantém o spot", () => {
    // Caso real: LT0Q8102C0G21 lançado no sistema, mas o LH está na planilha Shopee
    // SEM motorista (status "AGUARDANDO CHEGAR NO CLIENTE") → o spot sumia do Monitor.
    const sheet = [{ lh: "LT0Q8102C0G21", motoristas: "", status: "AGUARDANDO CHEGAR NO CLIENTE" }];
    const system = [{ lh: "LT0Q8102C0G21", cargoId: "c1", motoristas: "", lifecycleStatus: "OPEN" }];
    const out = reconcileMonitorDuplicates(sheet, system);
    expect(out.sheetRows).toHaveLength(0); // linha vazia da planilha escondida
    expect(out.systemRows.map((r) => r.cargoId)).toEqual(["c1"]); // spot lançado sobrevive
  });

  it("carga lançada (OPEN) JÁ COM motorista + planilha vazia (NO SHOW) → sistema vence", () => {
    // Caso real: LT1Q7L02BYDH1 — sistema OPEN com MARCUS TULIO alocado, mas a
    // planilha Shopee tem o LH SEM motorista (status "NO SHOW") → o Monitor mostrava
    // "NO SHOW" em vez do motorista alocado.
    const sheet = [{ lh: "LT1Q7L02BYDH1", motoristas: "", status: "NO SHOW" }];
    const system = [{ lh: "LT1Q7L02BYDH1", cargoId: "c1", motoristas: "MARCUS TULIO", lifecycleStatus: "OPEN" }];
    const out = reconcileMonitorDuplicates(sheet, system);
    expect(out.sheetRows).toHaveLength(0); // linha vazia da planilha escondida
    expect(out.systemRows.map((r) => r.cargoId)).toEqual(["c1"]); // carga do sistema (com motorista) vence
  });

  it("planilha COM motorista → planilha vence (dedup normal), spot do sistema escondido", () => {
    const sheet = [{ lh: "LT1", motoristas: "JOAO SILVA", status: "CARREGANDO" }];
    const system = [{ lh: "LT1", cargoId: "c1", motoristas: "", lifecycleStatus: "OPEN" }];
    const out = reconcileMonitorDuplicates(sheet, system);
    expect(out.sheetRows).toHaveLength(1); // planilha com motorista permanece
    expect(out.systemRows).toHaveLength(0); // duplicata do sistema escondida
  });

  it("system row NÃO OPEN (ex.: BOOKED) não esconde a planilha vazia (só spot lançado vence)", () => {
    const sheet = [{ lh: "LT1", motoristas: "", status: "NO SHOW" }];
    const system = [{ lh: "LT1", cargoId: "c1", motoristas: "", lifecycleStatus: "BOOKED" }];
    const out = reconcileMonitorDuplicates(sheet, system);
    expect(out.sheetRows).toHaveLength(1); // planilha mantida
    expect(out.systemRows).toHaveLength(0); // dedup normal dropa o sistema
  });

  it("LH sem colisão com a planilha → spot lançado aparece normalmente", () => {
    const sheet = [{ lh: "LT-OUTRA", motoristas: "MARIA" }];
    const system = [{ lh: "LT-NOVA", cargoId: "c1", motoristas: "", lifecycleStatus: "OPEN" }];
    const out = reconcileMonitorDuplicates(sheet, system);
    expect(out.sheetRows).toHaveLength(1);
    expect(out.systemRows.map((r) => r.cargoId)).toEqual(["c1"]);
  });

  it("não muta os arrays de entrada", () => {
    const sheet = [{ lh: "LT1", motoristas: "" }];
    const system = [{ lh: "LT1", cargoId: "c1", motoristas: "", lifecycleStatus: "OPEN" }];
    reconcileMonitorDuplicates(sheet, system);
    expect(sheet).toHaveLength(1);
    expect(system).toHaveLength(1);
  });
});
