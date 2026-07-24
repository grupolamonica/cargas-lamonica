import { describe, it, expect } from "vitest";

import { mergeAllocIntoRow } from "@/lib/monitorAllocOverlay";
import type { SheetMonitorAllocation, SheetMonitorRow } from "@/services/readModels";

const row = (over: Partial<SheetMonitorRow> = {}): SheetMonitorRow =>
  ({ lh: "LT1", motoristas: "DRIVER PLANILHA", cavalo: "CAVP", carreta: "CARP", status: "", tipo: "", ...over } as SheetMonitorRow);
const alloc = (over: Partial<SheetMonitorAllocation> = {}): SheetMonitorAllocation =>
  ({
    sheet_lh: "LT1", alloc_motorista: null, alloc_cavalo: null, alloc_carreta: null,
    alloc_status: null, alloc_tipo: null, alloc_descricao: null, alloc_vinculo: null,
    alloc_pinned: null, alloc_updated_at: null, ...over,
  } as SheetMonitorAllocation);

describe("mergeAllocIntoRow — overlay da alocação sobre a planilha", () => {
  it("sem alocação → linha da planilha inalterada", () => {
    expect(mergeAllocIntoRow(row(), undefined).motoristas).toBe("DRIVER PLANILHA");
  });

  it("VAZIO EXPLÍCITO (alloc='') → carga fica SEM motorista/veículo (não volta à planilha) — fix do swap", () => {
    // Regressão do bug: arrastar/trocar esvazia a origem (alloc=""); NÃO pode voltar
    // a mostrar o motorista antigo da planilha.
    const r = mergeAllocIntoRow(row(), alloc({ alloc_motorista: "", alloc_cavalo: "", alloc_carreta: "" }));
    expect(r.motoristas).toBe("");
    expect(r.cavalo).toBe("");
    expect(r.carreta).toBe("");
    expect(r.hasDriver).toBe(false);
    expect(r.isAvailable).toBe(true);
  });

  it("null (modal 'limpar') → volta a refletir a planilha", () => {
    const r = mergeAllocIntoRow(row(), alloc({ alloc_motorista: null, alloc_cavalo: null }));
    expect(r.motoristas).toBe("DRIVER PLANILHA");
    expect(r.cavalo).toBe("CAVP");
  });

  it("valor real → sobrepõe a planilha", () => {
    const r = mergeAllocIntoRow(row(), alloc({ alloc_motorista: "NOVO MOTORISTA", alloc_cavalo: "CAVN" }));
    expect(r.motoristas).toBe("NOVO MOTORISTA");
    expect(r.cavalo).toBe("CAVN");
    expect(r.hasDriver).toBe(true);
  });

  it("status/tipo vazios caem pro valor da linha (`||` — não entram no swap)", () => {
    const r = mergeAllocIntoRow(row({ status: "CARREGANDO", tipo: "SISTEMA" }), alloc({ alloc_status: "", alloc_tipo: "" }));
    expect(r.status).toBe("CARREGANDO"); // status vivo do SPX preservado
    expect(r.tipo).toBe("SISTEMA");
  });

  it("status real do operador (alloc_status) sobrepõe", () => {
    const r = mergeAllocIntoRow(row({ status: "CARREGANDO" }), alloc({ alloc_status: "AGUARDANDO CARREGAMENTO" }));
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });
});
