import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgTransaction,
} from "./test-harness.js";
import { createSheetLoadId } from "../google-sheets/google-sheet-loads.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { sweepCancelledCascades } = await import("./sweep-cancelled-cascades.js");

async function seedRouteCargo(lh, { motorista, horario, status } = {}) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN", origem: "Recife / PE", destino: "Olinda / PE", horario: horario ?? "08:00:00" });
  await query(`UPDATE public.cargas SET sheet_motorista = $2, sheet_status = $3 WHERE id = $1`, [id, motorista ?? null, status ?? null]);
  return id;
}

const reservas = async () => (await query(`SELECT * FROM public.monitor_reservas WHERE active = true`)).rows;

describe("sweepCancelledCascades", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cascateia cargas canceladas vindas da planilha (com motorista) e é idempotente", async () => {
    await seedRouteCargo("S1", { motorista: "JOAO", horario: "08:00:00" });
    await seedRouteCargo("S2", { motorista: "MARIA", horario: "12:00:00", status: "CANCELADO" });
    const s3 = await seedRouteCargo("S3", { motorista: "PEDRO", horario: "16:00:00" });

    const first = await sweepCancelledCascades({});
    expect(first.found).toBe(1);
    expect(first.cascaded).toBe(1);
    expect((await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [s3])).rows[0].alloc_motorista).toBe("MARIA");
    expect(await reservas()).toHaveLength(1);

    // Rodar de novo não acha mais nada (S2 já sem motorista) nem duplica reserva.
    const second = await sweepCancelledCascades({});
    expect(second.found).toBe(0);
    expect(await reservas()).toHaveLength(1);
  });

  it("ignora canceladas sem motorista", async () => {
    await seedRouteCargo("T1", { motorista: null, horario: "08:00:00", status: "CANCELADO" });
    const r = await sweepCancelledCascades({});
    expect(r.found).toBe(0);
    expect(r.cascaded).toBe(0);
  });
});
