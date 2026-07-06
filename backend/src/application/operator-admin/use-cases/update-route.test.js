import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedRoute,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { normalizeClientName } from "./_shared.js";

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
    const okey = normalizeClientName(origem).replace(/\s+/g, " ");
    const dkey = normalizeClientName(destino).replace(/\s+/g, " ");
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
});
