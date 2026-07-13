import { afterEach, describe, expect, it, vi } from "vitest";

// Mock do cache: devolve um Map<placaNorm, item[]> controlado.
const canned = { map: new Map() };
vi.mock("../vehicle-checklist-cache.js", () => ({
  readVehicleChecklistMapCached: async () => canned.map,
}));

const { fetchVehicleChecklist } = await import("./fetch-vehicle-checklist.js");

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const DAY = 86_400_000;

afterEach(() => {
  canned.map = new Map();
  vi.restoreAllMocks();
});

describe("fetchVehicleChecklist", () => {
  it("indexa a resposta pela placa EXATA da query (com hífen) e casa por placa normalizada", async () => {
    canned.map = new Map([
      ["MTY0443", [{ tipoVeiculo: "CARRETA 1", statusRaw: "Aprovado", validadeMs: NOW + 60 * DAY, validadeLabel: "30/06/2026 00:00:00" }]],
    ]);

    const { payload } = await fetchVehicleChecklist({ placas: "MTY-0443", nowMs: NOW });
    expect(payload.byPlaca["MTY-0443"]).toMatchObject({ found: true, level: "ok" });
    expect(payload.byPlaca["MTY-0443"].items[0].validade).toBe("30/06/2026 00:00:00");
  });

  it("consolida o pior nível e o menor daysToDue entre os itens do veículo", async () => {
    canned.map = new Map([
      ["ABC1D23", [
        { statusRaw: "Aprovado", validadeMs: NOW + 60 * DAY },
        { statusRaw: "Aprovado", validadeMs: NOW + 5 * DAY },
      ]],
    ]);
    const { payload } = await fetchVehicleChecklist({ placas: ["ABC1D23"], nowMs: NOW });
    expect(payload.byPlaca["ABC1D23"].level).toBe("warning");
    expect(payload.byPlaca["ABC1D23"].daysToDue).toBe(5);
  });

  it("placa sem checklist → found=false, level unknown, itens vazios", async () => {
    const { payload } = await fetchVehicleChecklist({ placas: "XYZ0A00", nowMs: NOW });
    expect(payload.byPlaca["XYZ0A00"]).toMatchObject({ found: false, level: "unknown" });
    expect(payload.byPlaca["XYZ0A00"].items).toEqual([]);
  });

  it("deduplica placas repetidas e ignora vazias", async () => {
    const { payload } = await fetchVehicleChecklist({ placas: "AAA1A11, ,AAA1A11", nowMs: NOW });
    expect(Object.keys(payload.byPlaca)).toEqual(["AAA1A11"]);
  });
});
