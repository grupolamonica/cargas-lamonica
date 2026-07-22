import { describe, expect, it } from "vitest";

import {
  applySpxOperationalStatus,
  fetchSpxStatusIndex,
  fetchSpxStatusIndexFromSnapshot,
  isSpxMonitorLiveStatusEnabled,
} from "./spx-operational-status.js";

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

describe("fetchSpxStatusIndexFromSnapshot (status AO VIVO do SPX no Monitor)", () => {
  it("mapeia trip_number → rótulo operacional via trip_status_name (aba aceito)", async () => {
    const fetchSpxTripsByTab = async (queryType) => {
      expect(queryType).toBe(2); // tab "aceito"
      return {
        trips: [
          { trip_number: "LT-CARREGANDO", trip_status_name: "loading" },
          { trip_number: "LT-DESCARGA", trip_status_name: "arrived" },
          { trip_number: "LT-DESC", trip_status_name: "completed" },
          { trip_number: "", trip_status_name: "loading" }, // sem lh → ignora
          { trip_number: "LT-SEM-STATUS" }, // sem status → ignora
        ],
      };
    };
    const map = await fetchSpxStatusIndexFromSnapshot({ force: true, deps: { fetchSpxTripsByTab } });
    // arrived → AGUARDANDO DESCARGA (destino), loading → CARREGANDO (origem): a
    // tradução que distingue origem×destino (o que a Torre errava).
    expect(map.get("LT-CARREGANDO")).toBe("CARREGANDO");
    expect(map.get("LT-DESCARGA")).toBe("AGUARDANDO DESCARGA");
    expect(map.get("LT-DESC")).toBe("DESCARREGADO");
    expect(map.size).toBe(3);
  });

  it("é leve: memoiza o índice (2ª leitura não rebusca o SPX)", async () => {
    let calls = 0;
    const fetchSpxTripsByTab = async () => {
      calls += 1;
      return { trips: [{ trip_number: "LT-X", trip_status_name: "departed" }] };
    };
    // force:true reseta o cache e busca 1×; a 2ª (sem force) lê do cache memoizado.
    await fetchSpxStatusIndexFromSnapshot({ force: true, deps: { fetchSpxTripsByTab } });
    const again = await fetchSpxStatusIndexFromSnapshot({ deps: { fetchSpxTripsByTab } });
    expect(again.get("LT-X")).toBe("CARREGADO"); // departed → CARREGADO
    expect(calls).toBe(1);
  });

  it("sidecar fora do ar → retorna null (best-effort, Monitor segue com status da planilha)", async () => {
    const fetchSpxTripsByTab = async () => {
      throw new Error("sidecar down");
    };
    expect(await fetchSpxStatusIndexFromSnapshot({ force: true, deps: { fetchSpxTripsByTab } })).toBeNull();
  });
});

describe("isSpxMonitorLiveStatusEnabled (kill-switch)", () => {
  const prev = process.env.SPX_MONITOR_LIVE_STATUS_ENABLED;
  it("LIGADO por padrão (env ausente)", () => {
    delete process.env.SPX_MONITOR_LIVE_STATUS_ENABLED;
    expect(isSpxMonitorLiveStatusEnabled()).toBe(true);
  });
  it("desliga só com 'false' explícito", () => {
    process.env.SPX_MONITOR_LIVE_STATUS_ENABLED = "false";
    expect(isSpxMonitorLiveStatusEnabled()).toBe(false);
    process.env.SPX_MONITOR_LIVE_STATUS_ENABLED = "true";
    expect(isSpxMonitorLiveStatusEnabled()).toBe(true);
    if (prev === undefined) delete process.env.SPX_MONITOR_LIVE_STATUS_ENABLED;
    else process.env.SPX_MONITOR_LIVE_STATUS_ENABLED = prev;
  });
});
