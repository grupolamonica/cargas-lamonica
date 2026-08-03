import { describe, it, expect } from "vitest";

import { mergeAllocIntoRow, effectiveAllocField } from "@/lib/monitorAllocOverlay";
import type { SheetMonitorAllocation, SheetMonitorRow } from "@/services/readModels";

const row = (over: Partial<SheetMonitorRow> = {}): SheetMonitorRow =>
  ({ lh: "LT1", motoristas: "DRIVER PLANILHA", cavalo: "CAVP", carreta: "CARP", status: "", tipo: "", ...over } as SheetMonitorRow);
const alloc = (over: Partial<SheetMonitorAllocation> = {}): SheetMonitorAllocation =>
  ({
    sheet_lh: "LT1", alloc_motorista: null, alloc_cavalo: null, alloc_carreta: null,
    alloc_status: null, alloc_tipo: null, alloc_descricao: null, alloc_vinculo: null,
    alloc_pinned: null, alloc_updated_at: null, ...over,
  } as SheetMonitorAllocation);

describe("effectiveAllocField — valor efetivo (linha E modal usam a MESMA fonte)", () => {
  it('"" (vazio explícito do swap) → fica vazio (não cai pra planilha)', () => {
    expect(effectiveAllocField("", "DRIVER PLANILHA")).toBe("");
  });
  it("null (modal 'limpar' / sem override) → valor da planilha", () => {
    expect(effectiveAllocField(null, "DRIVER PLANILHA")).toBe("DRIVER PLANILHA");
    expect(effectiveAllocField(undefined, "DRIVER PLANILHA")).toBe("DRIVER PLANILHA");
  });
  it("valor real → define", () => {
    expect(effectiveAllocField("NOVO", "DRIVER PLANILHA")).toBe("NOVO");
  });
  it("tudo nulo → string vazia (nunca undefined — evita input descontrolado)", () => {
    expect(effectiveAllocField(null, null)).toBe("");
  });
});

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

  it("status real do operador (alloc_status) sobrepõe quando NÃO há SPX ao vivo", () => {
    const r = mergeAllocIntoRow(row({ status: "CARREGANDO" }), alloc({ alloc_status: "AGUARDANDO CARREGAMENTO" }));
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });
});

describe("mergeAllocIntoRow — SPX ao vivo é autoritativo sobre alloc_status (fix do congelamento)", () => {
  it("spxStatus presente VENCE um alloc_status congelado (não remascara com o valor da atribuição)", () => {
    // Bug: alloc_status foi gravado "AGUARDANDO CHEGAR NO CLIENTE" no instante da
    // atribuição; o SPX já avançou p/ CARREGADO. O front deve mostrar o SPX ao vivo.
    const r = mergeAllocIntoRow(
      row({ status: "CARREGADO", spxStatus: "CARREGADO", motoristas: "JOAO" }),
      alloc({ alloc_motorista: "JOAO", alloc_status: "AGUARDANDO CHEGAR NO CLIENTE" }),
    );
    expect(r.status).toBe("CARREGADO");
  });

  it("spxStatus presente sem alloc_status → mostra o SPX ao vivo", () => {
    const r = mergeAllocIntoRow(
      row({ status: "AGUARDANDO DESCARGA", spxStatus: "AGUARDANDO DESCARGA", motoristas: "JOAO" }),
      alloc({ alloc_motorista: "JOAO", alloc_status: null }),
    );
    expect(r.status).toBe("AGUARDANDO DESCARGA");
  });

  it("terminal LOCAL do operador (CANCELADO) é preservado mesmo com SPX ao vivo", () => {
    const r = mergeAllocIntoRow(
      row({ status: "CARREGADO", spxStatus: "CARREGADO", motoristas: "JOAO" }),
      alloc({ alloc_motorista: "JOAO", alloc_status: "CANCELADO" }),
    );
    expect(r.status).toBe("CANCELADO");
  });

  it("no-show / desistiu também são preservados sobre o SPX", () => {
    expect(
      mergeAllocIntoRow(row({ status: "CARREGADO", spxStatus: "CARREGADO" }), alloc({ alloc_status: "NO SHOW" })).status,
    ).toBe("NO SHOW");
    expect(
      mergeAllocIntoRow(row({ status: "CARREGADO", spxStatus: "CARREGADO" }), alloc({ alloc_status: "MOTORISTA DESISTIU" })).status,
    ).toBe("MOTORISTA DESISTIU");
  });

  it("SEM spxStatus (não-SPX ou sidecar fora do ar) → alloc_status volta a valer", () => {
    const r = mergeAllocIntoRow(
      row({ status: "CTE ENVIADO" }),
      alloc({ alloc_status: "AGUARDANDO CARREGAMENTO" }),
    );
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });
});

describe("mergeAllocIntoRow — o SPX ao vivo só AVANÇA (não rebaixa o status salvo)", () => {
  it("NÃO rebaixa CTE EM EMISSÃO recém-salvo para o CARREGADO do SPX", () => {
    // Caso relatado em produção: o operador salva CTE EM EMISSÃO (status que o SPX não
    // conhece); o `spxStatus` que veio no fetch ANTERIOR ainda está na linha em cache e
    // vencia sempre → a linha "voltava sozinha" para CARREGADO.
    const r = mergeAllocIntoRow(
      row({ status: "CARREGADO", spxStatus: "CARREGADO", motoristas: "CLOVIS" }),
      alloc({ alloc_motorista: "CLOVIS", alloc_status: "CTE EM EMISSÃO" }),
    );
    expect(r.status).toBe("CTE EM EMISSÃO");
  });

  it("NÃO rebaixa CTE ENVIADO para CARREGADO", () => {
    expect(
      mergeAllocIntoRow(
        row({ status: "CARREGADO", spxStatus: "CARREGADO" }),
        alloc({ alloc_status: "CTE ENVIADO" }),
      ).status,
    ).toBe("CTE ENVIADO");
  });

  it("AVANÇA sobre o CTE quando o SPX passa dele (chegou no destino)", () => {
    expect(
      mergeAllocIntoRow(
        row({ status: "AGUARDANDO DESCARGA", spxStatus: "AGUARDANDO DESCARGA" }),
        alloc({ alloc_status: "CTE EM EMISSÃO" }),
      ).status,
    ).toBe("AGUARDANDO DESCARGA");
  });

  it("status FORA do pipeline (rótulo legado) é preservado — não há como afirmar avanço", () => {
    expect(
      mergeAllocIntoRow(
        row({ status: "CARREGADO", spxStatus: "CARREGADO" }),
        alloc({ alloc_status: "EM TRÂNISTO" }),
      ).status,
    ).toBe("EM TRÂNISTO");
  });

  it("override vazio/ausente → o SPX preenche (linha sem status é pior que o SPX)", () => {
    expect(
      mergeAllocIntoRow(row({ status: "", spxStatus: "CARREGADO" }), alloc({ alloc_status: "" })).status,
    ).toBe("CARREGADO");
    expect(
      mergeAllocIntoRow(row({ status: "", spxStatus: "CARREGADO" }), alloc({ alloc_status: null })).status,
    ).toBe("CARREGADO");
  });
});
