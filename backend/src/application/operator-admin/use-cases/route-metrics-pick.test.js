import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, resetTestDatabase, seedRoute, withPgClient } from "../test-harness.js";
import { buildDriverLoadPublicationState, fetchRouteCatalogMetricsByLoadId } from "./_shared.js";

const ORIGEM = "FEIRA DE SANTANA/BA";
const DESTINO = "JABOATÃO DOS GUARARAPES/PE";
const OKEY = "feira de santana/ba";
const DKEY = "jaboatao dos guararapes/pe";

async function seedTrechoTarifas() {
  // Mesmo trecho, dois veículos por nº de eixos com preços distintos.
  await seedRoute({
    origin_key: OKEY, destination_key: DKEY, origem: ORIGEM, destino: DESTINO,
    perfil_padrao: "CARRETA", eixos: 5, valor_padrao: 5900, bonus_padrao: 100, distancia_km: 780, duracao_horas: 16,
  });
  await seedRoute({
    origin_key: OKEY, destination_key: DKEY, origem: ORIGEM, destino: DESTINO,
    perfil_padrao: "CARRETA", eixos: 6, valor_padrao: 6450, bonus_padrao: 200, distancia_km: 780, duracao_horas: 16,
  });
}

const cargoRow = (over = {}) => ({
  id: over.id ?? "cargo-1",
  origem: ORIGEM,
  destino: DESTINO,
  perfil: "CARRETA",
  eixos: 0,
  ...over,
});

describe("fetchRouteCatalogMetricsByLoadId — pick por perfil + eixos", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("carga CARRETA 6 eixos herda o preço da tarifa de 6 eixos (não da de 5)", async () => {
    await seedTrechoTarifas();
    const result = await withPgClient((client) =>
      fetchRouteCatalogMetricsByLoadId(client, [cargoRow({ eixos: 6 })]),
    );
    const metrics = result.get("cargo-1");
    expect(metrics).not.toBeNull();
    expect(Number(metrics.valor_padrao)).toBe(6450);
    expect(Number(metrics.bonus_padrao)).toBe(200);
    // DC-258: os metrics agora expõem o nº de eixos da tarifa casada.
    expect(Number(metrics.eixos)).toBe(6);
  });

  it("carga CARRETA 5 eixos herda o preço da tarifa de 5 eixos", async () => {
    await seedTrechoTarifas();
    const result = await withPgClient((client) =>
      fetchRouteCatalogMetricsByLoadId(client, [cargoRow({ eixos: 5 })]),
    );
    const metrics = result.get("cargo-1");
    expect(Number(metrics.valor_padrao)).toBe(5900);
    expect(Number(metrics.eixos)).toBe(5);
  });

  it("carga sem eixos (0) num trecho só com 5/6 eixos cai no mesmo perfil (primeira tarifa), sem quebrar", async () => {
    await seedTrechoTarifas();
    const result = await withPgClient((client) =>
      fetchRouteCatalogMetricsByLoadId(client, [cargoRow({ eixos: 0 })]),
    );
    const metrics = result.get("cargo-1");
    expect(metrics).not.toBeNull();
    // Fallback: alguma tarifa CARRETA do trecho (5900 ou 6450) — e o eixo bate
    // com a tarifa escolhida (5↔5900, 6↔6450).
    expect([5900, 6450]).toContain(Number(metrics.valor_padrao));
    expect(Number(metrics.eixos)).toBe(Number(metrics.valor_padrao) === 5900 ? 5 : 6);
  });
});

describe("buildDriverLoadPublicationState — enriquece eixos do catálogo (DC-258)", () => {
  const readyMetrics = {
    perfil_padrao: "CARRETA",
    eixos: 6,
    valor_padrao: 6450,
    bonus_padrao: 200,
    distancia_km: 780,
    tempo_estimado_horas: 16,
    duracao_horas: 16,
  };

  it("carga sem eixos próprio herda o eixo da tarifa casada", () => {
    const state = buildDriverLoadPublicationState(
      { id: "c1", perfil: "CARRETA", eixos: null, valor: null },
      readyMetrics,
      "FEIRA X JABOATAO",
    );
    expect(state.isReady).toBe(true);
    expect(state.row.eixos).toBe(6);
  });

  it("carga com eixo próprio preserva o seu (não sobrescreve com o catálogo)", () => {
    const state = buildDriverLoadPublicationState(
      { id: "c2", perfil: "CARRETA", eixos: 3, valor: 5000 },
      readyMetrics,
      "FEIRA X JABOATAO",
    );
    expect(state.row.eixos).toBe(3);
  });
});
