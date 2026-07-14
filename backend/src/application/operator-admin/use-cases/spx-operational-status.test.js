import { describe, expect, it } from "vitest";

import { applySpxOperationalStatus, fetchSpxStatusIndex } from "./spx-operational-status.js";

function row(over = {}) {
  return { lh: "LT1", status: "AGUARDANDO CARREGAMENTO", motoristas: "JOÃO", ...over };
}

describe("applySpxOperationalStatus", () => {
  const idx = new Map([["LT1", "CARREGADO"], ["LT2", "DESCARREGADO"]]);

  it("sobrepõe o status pela viagem do SPX quando há motorista alocado e o LH bate", () => {
    const r = applySpxOperationalStatus(row(), { spxStatusByLh: idx });
    expect(r.status).toBe("CARREGADO");
    expect(r.spxStatus).toBe("CARREGADO");
  });

  it("usa o motorista efetivo do override (alloc) para decidir 'alocado'", () => {
    const r = applySpxOperationalStatus(row({ motoristas: "" }), {
      spxStatusByLh: idx,
      allocByLh: { LT1: { alloc_motorista: "MARIA" } },
    });
    expect(r.status).toBe("CARREGADO");
  });

  it("NÃO sobrepõe quando não há motorista alocado no sistema", () => {
    const r = applySpxOperationalStatus(row({ motoristas: "" }), { spxStatusByLh: idx });
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
    expect(r.spxStatus).toBeUndefined();
  });

  it("alloc '' (operador limpou) → não é alocado → não sobrepõe", () => {
    const r = applySpxOperationalStatus(row({ motoristas: "JOÃO DA PLANILHA" }), {
      spxStatusByLh: idx,
      allocByLh: { LT1: { alloc_motorista: "" } },
    });
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("LH sem viagem no SPX → no-op", () => {
    const r = applySpxOperationalStatus(row({ lh: "LT-NAO-EXISTE" }), { spxStatusByLh: idx });
    expect(r.status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("sem índice (Torre fora / sem chave) → no-op", () => {
    expect(applySpxOperationalStatus(row(), { spxStatusByLh: null }).status).toBe("AGUARDANDO CARREGAMENTO");
    expect(applySpxOperationalStatus(row(), { spxStatusByLh: new Map() }).status).toBe("AGUARDANDO CARREGAMENTO");
  });
});

describe("fetchSpxStatusIndex", () => {
  it("indexa 'LH Trip Number' → 'Status Operacional' das linhas da Torre", async () => {
    const fetchSpx = async () => ({
      rows: [
        { "LH Trip Number": "LT1Q7902B6I41", "Status Operacional": "AGUARDANDO CHEGAR NO CLIENTE" },
        { "LH Trip Number": "LT9", "Status Operacional": "DESCARREGADO" },
        { "LH Trip Number": "", "Status Operacional": "CARREGADO" }, // sem lh → ignora
      ],
    });
    const map = await fetchSpxStatusIndex({ deps: { fetchSpx } });
    expect(map.get("LT1Q7902B6I41")).toBe("AGUARDANDO CHEGAR NO CLIENTE");
    expect(map.get("LT9")).toBe("DESCARREGADO");
    expect(map.size).toBe(2);
  });

  it("falha na Torre → retorna null (best-effort, não quebra o Monitor)", async () => {
    const fetchSpx = async () => {
      throw new Error("boom");
    };
    expect(await fetchSpxStatusIndex({ deps: { fetchSpx } })).toBeNull();
  });
});
