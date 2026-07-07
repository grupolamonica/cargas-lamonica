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

const { updateReserva } = await import("./update-reserva.js");

async function seedReserva(overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  await query(
    `INSERT INTO public.monitor_reservas (id, motorista, cavalo, carreta, origem, destino, route_key, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      overrides.motorista ?? "Motorista Antigo",
      overrides.cavalo ?? "OLD1234",
      overrides.carreta ?? "OLD5678",
      overrides.origem ?? "Salvador / BA",
      overrides.destino ?? "Simoes Filho / BA",
      overrides.route_key ?? "Salvador / BA→Simoes Filho / BA",
      overrides.active ?? true,
    ],
  );
  return id;
}

async function getReserva(id) {
  const { rows } = await query(
    `SELECT motorista, cavalo, carreta FROM public.monitor_reservas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("updateReserva", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("update parcial: só altera os campos informados, preserva o resto", async () => {
    const op = await seedUser({ email: "op-update-reserva@teste.local" });
    const id = await seedReserva();

    const res = await updateReserva({
      reservaId: id,
      motorista: "  Motorista Novo ",
      // cavalo/carreta undefined → preservados
      operatorId: op.id,
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.id).toBe(id);

    const row = await getReserva(id);
    expect(row.motorista).toBe("Motorista Novo");
    expect(row.cavalo).toBe("OLD1234");
    expect(row.carreta).toBe("OLD5678");
  });

  it("permite limpar cavalo/carreta com string vazia", async () => {
    const op = await seedUser({ email: "op-update-reserva-clear@teste.local" });
    const id = await seedReserva();

    await updateReserva({ reservaId: id, cavalo: "", carreta: "", operatorId: op.id });

    const row = await getReserva(id);
    expect(row.motorista).toBe("Motorista Antigo");
    expect(row.cavalo).toBe("");
    expect(row.carreta).toBe("");
  });

  it("reserva inexistente/inativa → NotFoundError 404", async () => {
    const op = await seedUser({ email: "op-update-reserva-404@teste.local" });
    const id = await seedReserva({ active: false });

    let err;
    try {
      await updateReserva({ reservaId: id, motorista: "X", operatorId: op.id });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(404);
    expect(String(err.message)).toMatch(/não encontrada|nao encontrada/i);
  });

  it("motorista explicitamente vazio → ValidationError", async () => {
    const op = await seedUser({ email: "op-update-reserva-empty@teste.local" });
    const id = await seedReserva();
    await expect(
      updateReserva({ reservaId: id, motorista: "   ", operatorId: op.id }),
    ).rejects.toThrow(/motorista/i);
  });
});
