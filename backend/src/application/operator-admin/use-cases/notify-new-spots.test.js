import { describe, it, expect } from "vitest";

import { notifyNewSpots } from "./notify-new-spots.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";

// Rota selecionada pelo operador = a de SP→Salvador (mesma normalização do catálogo).
const SELECTED_KEYS = createRouteLookupKeys("São Paulo/SP", "Salvador/BA");

function makeRow(over) {
  return {
    lh: "LT-1",
    origem: "SAO PAULO/SP · CD",
    destino: "SALVADOR/BA · CD",
    origemCidadeUf: "São Paulo/SP",
    destinoCidadeUf: "Salvador/BA",
    data: "2026-07-25",
    horario: "08:00",
    tab: "planejado",
    isLinehaul: true,
    podeLancar: true,
    jaLancada: false,
    expirada: false,
    ...over,
  };
}

// Fake pg client: responde à query de dedup e grava os INSERTs.
function makeDeps({ rows, alertKeys, alreadyLhs = [] }) {
  const inserts = [];
  const fakeClient = {
    query: (sql, params) => {
      if (/SELECT DISTINCT metadata/.test(sql)) {
        return Promise.resolve({ rows: alreadyLhs.map((lh) => ({ lh })) });
      }
      if (/INSERT INTO public\.operator_notifications/.test(sql)) {
        inserts.push({ title: params[0], body: params[1], metadata: JSON.parse(params[2]) });
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const deps = {
    getSpotAlertRouteKeys: async () => alertKeys,
    getProgramacao: async () => ({ statusCode: 200, payload: { rows } }),
    withPgClient: (fn) => fn(fakeClient),
  };
  return { deps, inserts };
}

describe("notifyNewSpots (DC-279)", () => {
  it("não faz nada quando nenhuma rota está selecionada", async () => {
    const { deps, inserts } = makeDeps({ rows: [makeRow()], alertKeys: [] });
    const res = await notifyNewSpots({ deps });
    expect(res.reason).toBe("no_routes_selected");
    expect(res.notified).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("notifica só o spot disponível cuja rota foi selecionada", async () => {
    const rows = [
      makeRow({ lh: "LT-A" }), // SP→Salvador (selecionada) → notifica
      makeRow({ lh: "LT-B", origemCidadeUf: "Recife/PE", destinoCidadeUf: "Fortaleza/CE" }), // rota não selecionada
      makeRow({ lh: "LT-C", expirada: true }), // expirada → ignora
      makeRow({ lh: "LT-D", data: null }), // sem data ("a confirmar") → ignora
      makeRow({ lh: "LT-E", tab: "planejado", isLinehaul: false }), // não line-haul → ignora
    ];
    const { deps, inserts } = makeDeps({ rows, alertKeys: SELECTED_KEYS });
    const res = await notifyNewSpots({ deps });

    expect(res.notified).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].metadata.lh).toBe("LT-A");
    expect(inserts[0].title).toContain("São Paulo/SP");
    expect(inserts[0].metadata.route_key).toBeTruthy();
  });

  it("notifica spot JÁ LANÇADO (auto-launch publica no portal mas não aceita no SPX) — #3", () => {
    const rows = [makeRow({ lh: "LT-A", jaLancada: true })];
    const { deps, inserts } = makeDeps({ rows, alertKeys: SELECTED_KEYS });
    return notifyNewSpots({ deps }).then((res) => {
      expect(res.notified).toBe(1);
      expect(inserts[0].metadata.lh).toBe("LT-A");
    });
  });

  it("dedup dentro da mesma leva: LH repetido no feed gera 1 notificação só — #5", async () => {
    const rows = [makeRow({ lh: "LT-A" }), makeRow({ lh: "LT-A" })]; // mesma LH duas vezes
    const { deps, inserts } = makeDeps({ rows, alertKeys: SELECTED_KEYS });
    const res = await notifyNewSpots({ deps });
    expect(res.notified).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  it("dedup: não renotifica um LH já notificado nas últimas 24h", async () => {
    const rows = [makeRow({ lh: "LT-A" })];
    const { deps, inserts } = makeDeps({ rows, alertKeys: SELECTED_KEYS, alreadyLhs: ["LT-A"] });
    const res = await notifyNewSpots({ deps });

    expect(res.notified).toBe(0);
    expect(res.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("no-op silencioso se o feed do SPX estiver indisponível", async () => {
    const deps = {
      getSpotAlertRouteKeys: async () => SELECTED_KEYS,
      getProgramacao: async () => ({ statusCode: 503, payload: { error: "spx_unavailable" } }),
      withPgClient: (fn) => fn({ query: () => Promise.resolve({ rows: [] }) }),
    };
    const res = await notifyNewSpots({ deps });
    expect(res.ok).toBe(false);
    expect(res.notified).toBe(0);
  });
});
