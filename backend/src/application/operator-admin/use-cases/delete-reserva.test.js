import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { deleteReserva } = await import("./delete-reserva.js");

async function seedReserva(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.monitor_reservas (id, motorista, origem, destino, route_key, active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      overrides.motorista ?? "Motorista X",
      overrides.origem ?? "Salvador / BA",
      overrides.destino ?? "Simoes Filho / BA",
      overrides.route_key ?? "Salvador / BA→Simoes Filho / BA",
      overrides.active ?? true,
    ],
  );
  return id;
}

describe("deleteReserva", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("soft delete: marca active=false (não apaga o registro)", async () => {
    const op = await seedUser({ email: "op-delete-reserva@teste.local" });
    const id = await seedReserva();

    const res = await deleteReserva({ reservaId: id, operatorId: op.id, correlationId: "c1" });
    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);

    const { rows } = await query(`SELECT active FROM public.monitor_reservas WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
  });

  it("reserva inexistente/já removida → NotFoundError 404", async () => {
    const op = await seedUser({ email: "op-delete-reserva-404@teste.local" });
    const id = await seedReserva({ active: false });

    let err;
    try {
      await deleteReserva({ reservaId: id, operatorId: op.id });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(404);
    expect(String(err.message)).toMatch(/não encontrada|nao encontrada|removida/i);
  });
});
