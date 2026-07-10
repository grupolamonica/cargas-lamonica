import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { normalizeClientName } from "./_shared.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { saveRouteTrecho } = await import("./save-route-trecho.js");

const ORIGEM = "Campo Grande / MS";
const DESTINO = "Simoes Filho / BA";
const okey = normalizeClientName(ORIGEM).replace(/\s+/g, " ");
const dkey = normalizeClientName(DESTINO).replace(/\s+/g, " ");

const trecho = (tarifas, over = {}) => ({
  origem: ORIGEM,
  destino: DESTINO,
  distancia_km: 1600,
  duracao_horas: 30,
  tempo_estimado_horas: 30,
  ativa: true,
  observacoes: null,
  tarifas,
  ...over,
});

async function tarifasFor() {
  const { rows } = await query(
    `SELECT perfil_padrao, eixos, valor_padrao, bonus_padrao
       FROM public.route_metrics_cache
      WHERE origin_key = $1 AND destination_key = $2
      ORDER BY perfil_padrao ASC, eixos ASC`,
    [okey, dkey],
  );
  return rows;
}

describe("saveRouteTrecho", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cria N tarifas por veículo para um trecho novo", async () => {
    const op = await seedUser({ email: "op-trecho-create@teste.local" });

    const res = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 200, bonus_exigencias: null },
        { perfil: "BITREM", eixos: 6, valor: 9000, bonus: 500, bonus_exigencias: "Rastreador" },
      ]),
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.tarifasCount).toBe(2);

    const rows = await tarifasFor();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.perfil_padrao, r.eixos])).toEqual([
      ["BITREM", 6],
      ["CARRETA", 2],
    ]);
    const carreta = rows.find((r) => r.perfil_padrao === "CARRETA");
    expect(Number(carreta.valor_padrao)).toBe(5000);
    expect(Number(carreta.bonus_padrao)).toBe(200);
  });

  it("remove tarifa que saiu da lista (DELETE escopado ao trecho)", async () => {
    const op = await seedUser({ email: "op-trecho-delete@teste.local" });

    // Estado inicial: 3 tarifas.
    await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 0, bonus_exigencias: null },
        { perfil: "CARRETA", eixos: 3, valor: 5500, bonus: 0, bonus_exigencias: null },
        { perfil: "BITREM", eixos: 6, valor: 9000, bonus: 0, bonus_exigencias: null },
      ]),
      correlationId: "c1",
    });
    expect(await tarifasFor()).toHaveLength(3);

    // Re-salva só com 2 (removeu CARRETA 3 eixos).
    const res = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 0, bonus_exigencias: null },
        { perfil: "BITREM", eixos: 6, valor: 9000, bonus: 0, bonus_exigencias: null },
      ]),
      correlationId: "c2",
    });

    expect(res.payload.deletedCount).toBe(1);
    const rows = await tarifasFor();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.perfil_padrao === "CARRETA" && r.eixos === 3)).toBe(false);
  });

  it("atualiza valor/bônus de tarifa existente sem duplicar", async () => {
    const op = await seedUser({ email: "op-trecho-update@teste.local" });

    await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([{ perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 100, bonus_exigencias: null }]),
      correlationId: "c1",
    });

    await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([{ perfil: "CARRETA", eixos: 2, valor: 6200, bonus: 350, bonus_exigencias: null }]),
      correlationId: "c2",
    });

    const rows = await tarifasFor();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].valor_padrao)).toBe(6200);
    expect(Number(rows[0].bonus_padrao)).toBe(350);
  });

  it("cascata: atualiza carga OPEN do mesmo trecho + perfil + eixos", async () => {
    const op = await seedUser({ email: "op-trecho-cascade@teste.local" });
    const cargo = await seedCargo({
      origem: ORIGEM,
      destino: DESTINO,
      perfil: "CARRETA",
      status: "OPEN",
      valor: 1,
      bonus: 1,
    });
    // seedCargo não seta eixos (fica null → tratado como 0 no match).
    await query(`UPDATE public.cargas SET eixos = 2 WHERE id = $1`, [cargo.id]);

    const res = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([{ perfil: "CARRETA", eixos: 2, valor: 7777, bonus: 333, bonus_exigencias: null }]),
      correlationId: "c1",
    });

    expect(res.payload.cascadedCargaCount).toBe(1);
    const { rows } = await query(`SELECT valor, bonus FROM public.cargas WHERE id = $1`, [cargo.id]);
    expect(Number(rows[0].valor)).toBe(7777);
    expect(Number(rows[0].bonus)).toBe(333);
  });

  it("cascata NÃO atinge carga de outro perfil no mesmo trecho", async () => {
    const op = await seedUser({ email: "op-trecho-cascade-guard@teste.local" });
    const cargo = await seedCargo({
      origem: ORIGEM,
      destino: DESTINO,
      perfil: "BITREM",
      status: "OPEN",
      valor: 1000,
      bonus: 50,
    });
    await query(`UPDATE public.cargas SET eixos = 6 WHERE id = $1`, [cargo.id]);

    // Salva só a tarifa CARRETA — não deve tocar a carga BITREM.
    await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([{ perfil: "CARRETA", eixos: 2, valor: 7777, bonus: 333, bonus_exigencias: null }]),
      correlationId: "c1",
    });

    const { rows } = await query(`SELECT valor, bonus FROM public.cargas WHERE id = $1`, [cargo.id]);
    expect(Number(rows[0].valor)).toBe(1000);
    expect(Number(rows[0].bonus)).toBe(50);
  });

  it("rejeita (perfil, eixos) duplicado no payload → ValidationError", async () => {
    const op = await seedUser({ email: "op-trecho-dup@teste.local" });
    let err;
    try {
      await saveRouteTrecho({
        operatorId: op.id,
        payload: trecho([
          { perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 0, bonus_exigencias: null },
          { perfil: "CARRETA", eixos: 2, valor: 6000, bonus: 0, bonus_exigencias: null },
        ]),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.statusCode).toBe(400);
  });

  it("rejeita lista de tarifas vazia → ValidationError", async () => {
    const op = await seedUser({ email: "op-trecho-empty@teste.local" });
    let err;
    try {
      await saveRouteTrecho({
        operatorId: op.id,
        payload: trecho([]),
        correlationId: "c1",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("VALIDATION_ERROR");
  });
});
