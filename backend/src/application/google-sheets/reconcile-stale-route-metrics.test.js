import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartilhado: cargas canned + captura de UPDATEs + catálogo de rotas.
const state = { cargas: [], updates: [], catalog: new Map() };

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql, params) => {
        if (/UPDATE\s+public\.cargas/i.test(sql)) {
          state.updates.push({ sql, params });
          return { rows: [] };
        }
        return { rows: state.cargas }; // SELECT das cargas
      },
    }),
}));

// Matcher do catálogo — devolve o Map id→métricas montado por cada teste.
vi.mock("../operator-admin/use-cases/_shared.js", () => ({
  fetchRouteCatalogMetricsByLoadId: vi.fn(async () => state.catalog),
}));

const { reconcileStaleRouteMetrics } = await import("./reconcile-stale-route-metrics.js");

// Params do UPDATE: [id, valor, bonus, distancia, duracao]
const asUpdate = (u) => ({ id: u.params[0], valor: u.params[1], bonus: u.params[2], distancia: u.params[3], duracao: u.params[4] });

describe("reconcileStaleRouteMetrics", () => {
  beforeEach(() => {
    state.cargas = [];
    state.updates = [];
    state.catalog = new Map();
  });

  it("re-deriva a carga com distância DEFASADA (métricas de outra rota) do catálogo", async () => {
    // Carga Simões→Jaboatão (784km) presa em R$600/28km da rota Simões→Salvador.
    state.cargas = [{ id: "c1", sheet_lh: "LT0Q8102C0G21", lh_manual: null, origem: "Simoes Filho / BA", destino: "Jaboatão dos Guararapes / PE", perfil: "CARRETA", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 1.98 }];
    state.catalog = new Map([["c1", { valor_padrao: 5300, bonus_padrao: 300, distancia_km: 784, duracao_horas: 8.6 }]]);

    const res = await reconcileStaleRouteMetrics();
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(asUpdate(state.updates[0])).toEqual({ id: "c1", valor: 5300, bonus: 300, distancia: 784, duracao: 8.6 });
  });

  it("re-deriva também carga do SISTEMA (lh_manual) e no sentido OVERprecificado", async () => {
    // Simões→Feira (92km) presa em R$5300/784km de uma rota longa antiga.
    state.cargas = [{ id: "c2", sheet_lh: null, lh_manual: "LT0Q5U026GH51", origem: "Simoes Filho / BA", destino: "Feira de Santana / BA", perfil: "CARRETA", valor: 5300, bonus: 0, distancia_km: 784, duracao_horas: 8.6 }];
    state.catalog = new Map([["c2", { valor_padrao: 1100, bonus_padrao: 200, distancia_km: 92, duracao_horas: 1.5 }]]);

    const res = await reconcileStaleRouteMetrics();
    expect(res.updated).toBe(1);
    expect(asUpdate(state.updates[0])).toEqual({ id: "c2", valor: 1100, bonus: 200, distancia: 92, duracao: 1.5 });
  });

  it("NÃO toca carga cujo valor difere mas a distância BATE (edição de preço / drift de catálogo)", async () => {
    // distancia 780 vs rota 784 (<15%) → não é defasagem de ROTA; valor 6000 preservado.
    state.cargas = [{ id: "c3", sheet_lh: "L3", lh_manual: null, origem: "A", destino: "B", perfil: "CARRETA", valor: 6000, bonus: 300, distancia_km: 780, duracao_horas: 8 }];
    state.catalog = new Map([["c3", { valor_padrao: 5300, bonus_padrao: 300, distancia_km: 784, duracao_horas: 8.6 }]]);

    const res = await reconcileStaleRouteMetrics();
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("NÃO toca carga sem rota no catálogo (nada p/ re-derivar)", async () => {
    state.cargas = [{ id: "c4", sheet_lh: "L4", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 }];
    state.catalog = new Map(); // sem match

    const res = await reconcileStaleRouteMetrics();
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("NÃO toca quando a rota do catálogo não tem valor (só re-deriva com valor de rota)", async () => {
    state.cargas = [{ id: "c5", sheet_lh: "L5", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 }];
    state.catalog = new Map([["c5", { valor_padrao: null, bonus_padrao: null, distancia_km: 784, duracao_horas: null }]]);

    const res = await reconcileStaleRouteMetrics();
    expect(res.updated).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it("bônus/duração nulos no catálogo: grava bônus null e preserva duração (COALESCE)", async () => {
    state.cargas = [{ id: "c6", sheet_lh: "L6", lh_manual: null, origem: "X", destino: "Y", perfil: "CARRETA", valor: 600, bonus: 100, distancia_km: 28, duracao_horas: 2 }];
    state.catalog = new Map([["c6", { valor_padrao: 4800, bonus_padrao: null, distancia_km: 782, duracao_horas: null }]]);

    const res = await reconcileStaleRouteMetrics();
    expect(res.updated).toBe(1);
    const u = asUpdate(state.updates[0]);
    expect(u.valor).toBe(4800);
    expect(u.bonus).toBeNull();
    expect(u.distancia).toBe(782);
    expect(u.duracao).toBeNull(); // COALESCE no SQL preserva a duração existente
  });
});
