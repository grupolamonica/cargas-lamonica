import { afterEach, describe, expect, it, vi } from "vitest";

// Mock do cache: devolve um Map<placaNorm, item[]> controlado.
const canned = { map: new Map() };
vi.mock("../vehicle-checklist-cache.js", () => ({
  readVehicleChecklistMapCached: async () => canned.map,
}));

const { fetchVehicleChecklist, fetchVehicleChecklistLevels } = await import("./fetch-vehicle-checklist.js");

const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);
const DAY = 86_400_000;

afterEach(() => {
  canned.map = new Map();
  vi.restoreAllMocks();
});

describe("fetchVehicleChecklist", () => {
  it("indexa a resposta pela placa EXATA da query (com hífen) e casa por placa normalizada", async () => {
    canned.map = new Map([
      ["MTY0443", [{ tipoVeiculo: "CARRETA 1", statusRaw: "Aprovado", vencimentoDias: 60 }]],
    ]);

    const { payload } = await fetchVehicleChecklist({ placas: "MTY-0443", nowMs: NOW });
    expect(payload.byPlaca["MTY-0443"]).toMatchObject({ found: true, level: "ok", daysToDue: 60 });
    expect(payload.byPlaca["MTY-0443"].items[0].tipoVeiculo).toBe("CARRETA 1");
  });

  it("usa a validade real da consulta (aba viva ChecklistViaAPI) — caso FDB0605", async () => {
    canned.map = new Map([
      ["FDB0605", [{ statusRaw: "Aprovado", validadeMs: NOW + 2 * DAY, vencimentoDias: 2, dataInclusao: "13/07/2026 07:20:10" }]],
    ]);
    const { payload } = await fetchVehicleChecklist({ placas: "FDB-0605", nowMs: NOW });
    expect(payload.byPlaca["FDB-0605"]).toMatchObject({ found: true, level: "warning", daysToDue: 2 });
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

  it("fetchVehicleChecklistLevels devolve mapa compacto (level+daysToDue) por placa normalizada", async () => {
    canned.map = new Map([
      ["ABC1D23", [{ statusRaw: "Aprovado", validadeMs: NOW + 5 * DAY }]],
      ["XYZ9K88", [{ statusRaw: "Reprovado", validadeMs: NOW + 90 * DAY }]],
    ]);
    const { payload } = await fetchVehicleChecklistLevels({ nowMs: NOW });
    expect(payload.byPlaca.ABC1D23).toEqual({ level: "warning", daysToDue: 5 });
    expect(payload.byPlaca.XYZ9K88.level).toBe("overdue"); // reprovado força vermelho
    // Compacto: sem lista de itens.
    expect(payload.byPlaca.ABC1D23.items).toBeUndefined();
    expect(payload.meta.count).toBe(2);
  });
});
