import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedRoute,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { buildRouteCatalogKeys } from "../../../domain/operator-admin/route-utils.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { updateOperatorRoute } = await import("./update-route.js");

// Metricas no payload evitam a chamada de rede (resolveRouteMetricsIfNeeded).
const payload = (over = {}) => ({
  origem: "X / BA",
  destino: "Y / BA",
  perfil_padrao: "CARRETA",
  eixos: 0,
  distancia_km: 100,
  duracao_horas: 2,
  tempo_estimado_horas: 2,
  valor_padrao: 5000,
  bonus_padrao: 0,
  bonus_exigencias: null,
  ativa: true,
  observacoes: null,
  ...over,
});

describe("updateOperatorRoute", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("editar rota para um trecho+perfil+eixos que ja existe → ConflictError 409 (nao 500 opaco)", async () => {
    const origem = "CAMPO GRANDE / MS";
    const destino = "Simoes Filho / BA";
    const { originKey: okey, destinationKey: dkey } = buildRouteCatalogKeys(origem, destino);
    // Rota B ja ocupa (okey, dkey, CARRETA, 0).
    await seedRoute({ origin_key: okey, destination_key: dkey, origem, destino, perfil_padrao: "CARRETA" });
    // Rota A (trecho diferente) que vamos tentar mover para o trecho de B.
    const a = await seedRoute({ origin_key: "salvador", destination_key: "feira", origem: "Salvador / BA", destino: "Feira / BA", perfil_padrao: "CARRETA" });
    const op = await seedUser({ email: "op-route-collision@teste.local" });

    let err;
    try {
      await updateOperatorRoute({ routeId: a.id, operatorId: op.id, payload: payload({ origem, destino }), correlationId: "c1" });
    } catch (e) {
      err = e;
    }
    expect(err, "deveria lançar em vez de resolver").toBeDefined();
    expect(err.code).toBe("CONFLICT");
    expect(err.statusCode).toBe(409);
    expect(String(err.message)).toMatch(/já existe uma rota/i);
  });

  // O dinheiro segue a tarifa. Antes, a cascata usava COALESCE($1, valor): limpar ou
  // desativar a tarifa deixava a carga aberta servindo o preço antigo (preço órfão) —
  // o operador via a rota sem valor/desativada e a carga no ar com o valor velho.
  describe("cascata do preço nas cargas abertas", () => {
    const ORIGEM = "X / BA";
    const DESTINO = "Y / BA";

    async function seedTrechoComCarga({ valor = 14700, bonus = 500 } = {}) {
      const { originKey, destinationKey } = buildRouteCatalogKeys(ORIGEM, DESTINO);
      const route = await seedRoute({
        origin_key: originKey,
        destination_key: destinationKey,
        origem: ORIGEM,
        destino: DESTINO,
        perfil_padrao: "CARRETA",
        valor_padrao: valor,
      });
      const cargo = await seedCargo({
        origem: ORIGEM,
        destino: DESTINO,
        perfil: "CARRETA",
        status: "OPEN",
        valor,
        bonus,
        distancia_km: 1855,
        duracao_horas: 30,
      });
      const op = await seedUser({ email: `op-cascade-${crypto.randomUUID()}@teste.local` });
      return { route, cargo, op };
    }

    const readCargo = async (id) => {
      const { rows } = await query(
        "SELECT valor, bonus, distancia_km, duracao_horas FROM public.cargas WHERE id = $1",
        [id],
      );
      return rows[0];
    };

    it("limpar o valor da tarifa limpa o valor da carga aberta (não mantém o preço antigo)", async () => {
      const { route, cargo, op } = await seedTrechoComCarga();

      const res = await updateOperatorRoute({
        routeId: route.id,
        operatorId: op.id,
        payload: payload({ origem: ORIGEM, destino: DESTINO, valor_padrao: null, bonus_padrao: null }),
        correlationId: "c-clear",
      });

      expect(res.statusCode).toBe(200);
      expect(res.payload.cascadedCargaCount).toBe(1);
      const after = await readCargo(cargo.id);
      expect(after.valor).toBeNull();
      expect(after.bonus).toBeNull();
    });

    it("desativar a rota zera o dinheiro da carga, mas preserva km/duração (fato físico)", async () => {
      const { route, cargo, op } = await seedTrechoComCarga();

      await updateOperatorRoute({
        routeId: route.id,
        operatorId: op.id,
        // Tarifa continua preenchida no payload — o que tira o preço do ar é ativa=false.
        payload: payload({ origem: ORIGEM, destino: DESTINO, valor_padrao: 14700, ativa: false }),
        correlationId: "c-off",
      });

      const after = await readCargo(cargo.id);
      expect(after.valor).toBeNull();
      expect(after.bonus).toBeNull();
      expect(Number(after.distancia_km)).toBe(100); // veio do payload (métrica da rota)
      expect(Number(after.duracao_horas)).toBe(2);
    });

    it("rota ativa com valor novo continua propagando o preço", async () => {
      const { route, cargo, op } = await seedTrechoComCarga();

      await updateOperatorRoute({
        routeId: route.id,
        operatorId: op.id,
        payload: payload({ origem: ORIGEM, destino: DESTINO, valor_padrao: 25700, bonus_padrao: 300 }),
        correlationId: "c-new",
      });

      const after = await readCargo(cargo.id);
      expect(Number(after.valor)).toBe(25700);
      expect(Number(after.bonus)).toBe(300);
    });
  });
});
