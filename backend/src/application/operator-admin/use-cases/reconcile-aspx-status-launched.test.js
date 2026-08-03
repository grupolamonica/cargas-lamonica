import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileAspxStatusForLaunched } from "./reconcile-aspx-status-launched.js";

// A carga LANÇADA (lh_manual) nunca recebia status: o sync do DC-316 casa por
// sheet_lh. Aqui as mesmas regras rodam sobre o conjunto complementar.

// Linha da aba ASP no formato bruto da Torre (só as chaves que o parse usa).
const aspRow = (lh, status) => ({
  "LH Trip Number": lh,
  "Status Operacional": status,
  "Driver ID": "",
  "Vehicle Plate Number": ",",
});

function makeDeps({ cargas = [], asp = [] } = {}) {
  const updates = [];
  const sheetPosts = [];
  return {
    updates,
    sheetPosts,
    deps: {
      fetchSpxTrips: async () => ({ rows: asp }),
      withPgClient: async (cb) =>
        cb({
          query: async (sql, params) => {
            if (/^\s*UPDATE/i.test(sql)) {
              updates.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
              return { rowCount: 1 };
            }
            return { rows: cargas };
          },
        }),
      writeAllocationsToSheet: async (list) => {
        sheetPosts.push(list);
        return { ok: true, updated: list.length };
      },
      isSheetWritebackEnabled: () => true,
    },
  };
}

describe("reconcileAspxStatusForLaunched", () => {
  beforeEach(() => {
    delete process.env.ASPX_STATUS_LAUNCHED;
  });
  afterEach(() => {
    delete process.env.ASPX_STATUS_LAUNCHED;
    vi.restoreAllMocks();
  });

  it("desligado por padrão → no-op (nem busca a aba ASP)", async () => {
    const fetchSpy = vi.fn();
    const r = await reconcileAspxStatusForLaunched({ deps: { fetchSpxTrips: fetchSpy } });
    expect(r.skipped).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dry: mede o que mudaria e NÃO grava nada", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "dry";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "DESCARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.mode).toBe("dry");
    expect(r.updated).toBe(1);
    expect(r.exemplos[0]).toContain('"(vazio)" → "DESCARREGADO"');
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
    expect(r.sheetWrites).toBe(0);
  });

  it("on: grava o espelho e manda o status para a planilha", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana", cavalo: "AAA1B22", carreta: "CCC3D44" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(updates[0].sql).toContain("SET sheet_status = $2");
    expect(updates[0].params).toEqual(["c1", "CARREGADO"]);
    expect(sheetPosts[0][0]).toMatchObject({ lh: "LT-A", status: "CARREGADO", motorista: "Ana", cavalo: "AAA1B22", carreta: "CCC3D44" });
    expect(r.sheetWrites).toBe(1);
  });

  it("on: solta o override do operador quando a planilha passou dele", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: "AGUARDANDO CHEGAR NO CLIENTE", alloc_status: "AGUARDANDO CARREGAMENTO", motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(r.overridesSoltos).toBe(1);
    expect(updates[0].sql).toContain("alloc_status = NULL");
  });

  // Gravar cancelamento faria sweepCancelledCascades disparar a cascata de rota
  // retroativa (já derrubou 39 motoristas da fila) — fica fora desta passada, mesmo
  // com status atual preenchido (onde a regra 2 do DC-316 permitiria).
  it("cancelamento/NO SHOW no ASP ficam FORA (cascata retroativa) — só contam", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [
        { id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" },
        { id: "c2", lh: "LT-B", sheet_status: "AGUARDANDO CHEGAR NO CLIENTE", alloc_status: null, motorista: "Bia" },
        { id: "c3", lh: "LT-C", sheet_status: "CARREGADO", alloc_status: null, motorista: "Cida" },
      ],
      asp: [aspRow("LT-A", "CANCELADO"), aspRow("LT-B", "CANCELADO"), aspRow("LT-C", "NO SHOW")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(r.excecoesIgnoradas).toBe(3);
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
  });

  it("respeita os intocáveis do DC-316 (NO SHOW / CTE EM EMISSÃO)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [
        { id: "c1", lh: "LT-A", sheet_status: "NO SHOW", alloc_status: null, motorista: "Ana" },
        { id: "c2", lh: "LT-B", sheet_status: "CTE EM EMISSÃO", alloc_status: null, motorista: "Bia" },
      ],
      asp: [aspRow("LT-A", "CARREGADO"), aspRow("LT-B", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("status já igual ao ASP → nada a fazer", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: "CARREGADO", alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("aba ASP vazia → no-op", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps } = makeDeps({ cargas: [], asp: [] });
    const r = await reconcileAspxStatusForLaunched({ deps });
    expect(r.skipped).toBe("empty-index");
  });
});
