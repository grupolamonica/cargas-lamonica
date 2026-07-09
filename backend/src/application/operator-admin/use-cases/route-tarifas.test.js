import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedRota,
  seedRotaTarifa,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { listRouteTarifas } = await import("./list-route-tarifas.js");
const { createRouteTarifa } = await import("./create-route-tarifa.js");
const { updateRouteTarifa } = await import("./update-route-tarifa.js");
const { deleteRouteTarifa } = await import("./delete-route-tarifa.js");
const { lookupRouteTarifa } = await import("./lookup-route-tarifa.js");

const tarifaPayload = (over = {}) => ({
  perfil: "CARRETA",
  eixos: 0,
  valor: 5000,
  bonus: 200,
  bonus_exigencias: null,
  observacoes: null,
  ativa: true,
  ...over,
});

describe("rota_tarifas use-cases", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  // ─── createRouteTarifa ─────────────────────────────────────────────────────

  it("createRouteTarifa: cria tarifa para (rota, perfil, eixos) e devolve 201", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const op = await seedUser({ email: "op-create-tarifa@teste.local" });

    const res = await createRouteTarifa({
      routeId: rota.id,
      operatorId: op.id,
      payload: tarifaPayload({ perfil: "BITREM", eixos: 6, valor: 9000, bonus: 500 }),
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(201);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.id).toEqual(expect.any(String));

    const { rows } = await query(
      `SELECT tipo_veiculo, eixos, valor_frete, bonus FROM public.rota_tarifas WHERE rota_id = $1`,
      [rota.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tipo_veiculo).toBe("BITREM");
    expect(rows[0].eixos).toBe(6);
    expect(Number(rows[0].valor_frete)).toBe(9000);
    expect(Number(rows[0].bonus)).toBe(500);
  });

  it("createRouteTarifa: mesmo perfil + eixos diferentes na mesma rota é permitido", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const op = await seedUser({ email: "op-create-2@teste.local" });

    await createRouteTarifa({
      routeId: rota.id,
      operatorId: op.id,
      payload: tarifaPayload({ perfil: "CARRETA", eixos: 2, valor: 5000 }),
      correlationId: "c1",
    });
    await createRouteTarifa({
      routeId: rota.id,
      operatorId: op.id,
      payload: tarifaPayload({ perfil: "CARRETA", eixos: 3, valor: 5500 }),
      correlationId: "c2",
    });

    const { rows } = await query(
      `SELECT tipo_veiculo, eixos, valor_frete FROM public.rota_tarifas WHERE rota_id = $1 ORDER BY eixos ASC`,
      [rota.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.eixos)).toEqual([2, 3]);
    expect(rows.map((r) => Number(r.valor_frete))).toEqual([5000, 5500]);
  });

  it("createRouteTarifa: duplicata em (rota, perfil, eixos) → ConflictError 409", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const op = await seedUser({ email: "op-create-dup@teste.local" });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 2 });

    let err;
    try {
      await createRouteTarifa({
        routeId: rota.id,
        operatorId: op.id,
        payload: tarifaPayload({ perfil: "CARRETA", eixos: 2 }),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err, "deveria lançar em vez de resolver").toBeDefined();
    expect(err.code).toBe("CONFLICT");
    expect(err.statusCode).toBe(409);
    expect(String(err.message)).toMatch(/j[aá] existe uma tarifa/i);
  });

  it("createRouteTarifa: rota inexistente → NotFoundError 404", async () => {
    const op = await seedUser({ email: "op-create-nf@teste.local" });
    let err;
    try {
      await createRouteTarifa({
        routeId: "00000000-0000-0000-0000-000000000000",
        operatorId: op.id,
        payload: tarifaPayload(),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("NOT_FOUND");
    expect(err.statusCode).toBe(404);
  });

  // ─── updateRouteTarifa ─────────────────────────────────────────────────────

  it("updateRouteTarifa: atualiza valor/bônus mantendo perfil+eixos", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const tarifa = await seedRotaTarifa({
      rota_id: rota.id,
      tipo_veiculo: "CARRETA",
      eixos: 2,
      valor_frete: 5000,
    });
    const op = await seedUser({ email: "op-update@teste.local" });

    const res = await updateRouteTarifa({
      routeId: rota.id,
      tarifaId: tarifa.id,
      operatorId: op.id,
      payload: tarifaPayload({ perfil: "CARRETA", eixos: 2, valor: 6200, bonus: 350 }),
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    const { rows } = await query(
      `SELECT valor_frete, bonus FROM public.rota_tarifas WHERE id = $1`,
      [tarifa.id],
    );
    expect(Number(rows[0].valor_frete)).toBe(6200);
    expect(Number(rows[0].bonus)).toBe(350);
  });

  it("updateRouteTarifa: mover para (perfil+eixos) já ocupado → ConflictError 409", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    // Ocupa (CARRETA, 3).
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 3 });
    // A é (CARRETA, 2) — vamos tentar mover para (CARRETA, 3).
    const a = await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 2 });
    const op = await seedUser({ email: "op-update-conflict@teste.local" });

    let err;
    try {
      await updateRouteTarifa({
        routeId: rota.id,
        tarifaId: a.id,
        operatorId: op.id,
        payload: tarifaPayload({ perfil: "CARRETA", eixos: 3 }),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("CONFLICT");
    expect(err.statusCode).toBe(409);
  });

  it("updateRouteTarifa: tarifa de outra rota → NotFoundError (nao vaza atualizacao cruzada)", async () => {
    const rotaA = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const rotaB = await seedRota({ origem: "C / BA", destino: "D / BA" });
    const tarifaB = await seedRotaTarifa({ rota_id: rotaB.id, tipo_veiculo: "CARRETA", eixos: 0 });
    const op = await seedUser({ email: "op-update-cross@teste.local" });

    let err;
    try {
      await updateRouteTarifa({
        routeId: rotaA.id, // rota errada
        tarifaId: tarifaB.id,
        operatorId: op.id,
        payload: tarifaPayload(),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("NOT_FOUND");
    expect(err.statusCode).toBe(404);
  });

  // ─── deleteRouteTarifa ─────────────────────────────────────────────────────

  it("deleteRouteTarifa: remove tarifa por id", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const tarifa = await seedRotaTarifa({ rota_id: rota.id });
    const op = await seedUser({ email: "op-delete@teste.local" });

    const res = await deleteRouteTarifa({
      routeId: rota.id,
      tarifaId: tarifa.id,
      operatorId: op.id,
      correlationId: "c1",
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await query(`SELECT id FROM public.rota_tarifas WHERE id = $1`, [tarifa.id]);
    expect(rows).toHaveLength(0);
  });

  it("deleteRouteTarifa: id inexistente → NotFoundError 404", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const op = await seedUser({ email: "op-delete-nf@teste.local" });

    let err;
    try {
      await deleteRouteTarifa({
        routeId: rota.id,
        tarifaId: "00000000-0000-0000-0000-000000000000",
        operatorId: op.id,
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("NOT_FOUND");
  });

  // ─── listRouteTarifas ──────────────────────────────────────────────────────

  it("listRouteTarifas: retorna tarifas ordenadas por (perfil, eixos)", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 3, valor_frete: 5500 });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 2, valor_frete: 5000 });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "BITREM", eixos: 6, valor_frete: 9000 });

    const res = await listRouteTarifas({ routeId: rota.id, correlationId: "c1" });
    expect(res.statusCode).toBe(200);
    expect(res.payload.items).toHaveLength(3);
    // Ordem esperada: BITREM 6 < CARRETA 2 < CARRETA 3 (ASC por tipo_veiculo depois eixos)
    expect(res.payload.items.map((t) => [t.tipo_veiculo, t.eixos])).toEqual([
      ["BITREM", 6],
      ["CARRETA", 2],
      ["CARRETA", 3],
    ]);
  });

  it("listRouteTarifas: rota sem tarifa cadastrada retorna items vazio", async () => {
    const rota = await seedRota({ origem: "A / BA", destino: "B / BA" });
    const res = await listRouteTarifas({ routeId: rota.id, correlationId: "c1" });
    expect(res.payload.items).toEqual([]);
  });

  it("listRouteTarifas: rota inexistente → NotFoundError 404", async () => {
    let err;
    try {
      await listRouteTarifas({
        routeId: "00000000-0000-0000-0000-000000000000",
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("NOT_FOUND");
  });

  // ─── lookupRouteTarifa ─────────────────────────────────────────────────────

  it("lookupRouteTarifa: (origem, destino, perfil, eixos) exato retorna a tarifa", async () => {
    const rota = await seedRota({ origem: "Salvador / BA", destino: "Simoes Filho / BA" });
    await seedRotaTarifa({
      rota_id: rota.id,
      tipo_veiculo: "CARRETA",
      eixos: 3,
      valor_frete: 5500,
      bonus: 250,
      bonus_exigencias: "GPS + rastreador",
    });

    const res = await lookupRouteTarifa({
      query: {
        origem: "Salvador / BA",
        destino: "Simoes Filho / BA",
        perfil: "CARRETA",
        eixos: 3,
      },
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.tarifa).not.toBeNull();
    expect(Number(res.payload.tarifa.valor_frete)).toBe(5500);
    expect(Number(res.payload.tarifa.bonus)).toBe(250);
    expect(res.payload.tarifa.bonus_exigencias).toBe("GPS + rastreador");
  });

  it("lookupRouteTarifa: sem correspondência retorna tarifa=null (nao 404)", async () => {
    const rota = await seedRota({ origem: "Salvador / BA", destino: "Simoes Filho / BA" });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 3 });

    const res = await lookupRouteTarifa({
      query: {
        origem: "Salvador / BA",
        destino: "Simoes Filho / BA",
        perfil: "BITREM", // não tem
        eixos: 3,
      },
      correlationId: "c1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.tarifa).toBeNull();
  });

  it("lookupRouteTarifa: tarifa inativa NAO aparece no lookup", async () => {
    const rota = await seedRota({ origem: "Salvador / BA", destino: "Simoes Filho / BA" });
    await seedRotaTarifa({
      rota_id: rota.id,
      tipo_veiculo: "CARRETA",
      eixos: 3,
      ativa: false,
    });

    const res = await lookupRouteTarifa({
      query: {
        origem: "Salvador / BA",
        destino: "Simoes Filho / BA",
        perfil: "CARRETA",
        eixos: 3,
      },
      correlationId: "c1",
    });
    expect(res.payload.tarifa).toBeNull();
  });

  it("lookupRouteTarifa: rota inativa NAO aparece no lookup", async () => {
    const rota = await seedRota({
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      ativa: false,
    });
    await seedRotaTarifa({ rota_id: rota.id, tipo_veiculo: "CARRETA", eixos: 3 });

    const res = await lookupRouteTarifa({
      query: {
        origem: "Salvador / BA",
        destino: "Simoes Filho / BA",
        perfil: "CARRETA",
        eixos: 3,
      },
      correlationId: "c1",
    });
    expect(res.payload.tarifa).toBeNull();
  });
});
