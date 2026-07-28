import { describe, expect, it, vi } from "vitest";

import {
  deleteRouteColor,
  isValidHexColor,
  listRouteColors,
  normalizeVehicle,
  upsertRouteColor,
} from "./programacao-route-colors.js";

// Fake pg client: captura a query + args e devolve `rows`/`rowCount` fixados.
function fakeClient(result = { rows: [], rowCount: 0 }) {
  const calls = [];
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      return result;
    }),
  };
}

describe("normalizeVehicle / isValidHexColor", () => {
  it("normaliza veículo (maiúsculas, espaços e hífen canônicos)", () => {
    expect(normalizeVehicle("  carreta   -   expressa ")).toBe("CARRETA - EXPRESSA");
    expect(normalizeVehicle("carreta-expressa")).toBe("CARRETA - EXPRESSA");
    expect(normalizeVehicle("truck")).toBe("TRUCK");
  });
  it("valida hex #rgb e #rrggbb; rejeita o resto", () => {
    expect(isValidHexColor("#fde047")).toBe(true);
    expect(isValidHexColor("#abc")).toBe(true);
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("#12")).toBe(false);
    expect(isValidHexColor("rgb(1,2,3)")).toBe(false);
  });
});

describe("listRouteColors", () => {
  it("mapeia as linhas p/ o shape do read model", async () => {
    const client = fakeClient({
      rows: [{ id: "a", partida: "8808", chegada: "10963", veiculo: "CARRETA", cor: "#fde047", updated_at: "2026-07-27T00:00:00Z" }],
      rowCount: 1,
    });
    const rules = await listRouteColors({ deps: { withPgClient: (fn) => fn(client) } });
    expect(rules).toEqual([
      { id: "a", partida: "8808", chegada: "10963", veiculo: "CARRETA", cor: "#fde047", updatedAt: "2026-07-27T00:00:00Z" },
    ]);
  });
  it("tabela ausente (42P01) → [] em vez de erro", async () => {
    const run = () => {
      const e = new Error("relation does not exist");
      e.code = "42P01";
      throw e;
    };
    const rules = await listRouteColors({ deps: { withPgClient: run } });
    expect(rules).toEqual([]);
  });
});

describe("upsertRouteColor", () => {
  it("normaliza veículo e faz upsert, devolvendo a regra", async () => {
    const client = fakeClient({
      rows: [{ id: "x", partida: "8808", chegada: "10963", veiculo: "CARRETA - EXPRESSA", cor: "#93c5fd", updated_at: null }],
      rowCount: 1,
    });
    const rule = await upsertRouteColor({
      partida: " 8808 ",
      chegada: "10963",
      veiculo: "carreta - expressa",
      cor: "#93c5fd",
      operatorId: "op-1",
      deps: { withPgTransaction: (fn) => fn(client) },
    });
    expect(rule.veiculo).toBe("CARRETA - EXPRESSA");
    // args normalizados p/ a query
    expect(client.calls[0].params).toEqual(["8808", "10963", "CARRETA - EXPRESSA", "#93c5fd", "op-1"]);
  });
  it("rejeita cor inválida com statusCode 400", async () => {
    await expect(
      upsertRouteColor({ partida: "8808", chegada: "10963", veiculo: "CARRETA", cor: "roxo", deps: {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("rejeita campos faltando com statusCode 400", async () => {
    await expect(
      upsertRouteColor({ partida: "", chegada: "10963", veiculo: "CARRETA", cor: "#fde047", deps: {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("deleteRouteColor", () => {
  const UUID = "11111111-2222-4333-8444-555566667777";
  it("remove por id (uuid válido) e devolve { deleted: true }", async () => {
    const client = fakeClient({ rows: [], rowCount: 1 });
    const res = await deleteRouteColor({ id: UUID, deps: { withPgClient: (fn) => fn(client) } });
    expect(res).toEqual({ deleted: true });
    expect(client.calls[0].params).toEqual([UUID]);
  });
  it("id vazio → statusCode 400", async () => {
    await expect(deleteRouteColor({ id: "  ", deps: {} })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("id malformado (não-uuid) → statusCode 400 (não 500 no cast)", async () => {
    await expect(deleteRouteColor({ id: "abc", deps: {} })).rejects.toMatchObject({ statusCode: 400 });
  });
});
