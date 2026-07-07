import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { createReserva } = await import("./create-reserva.js");

async function countActiveReservas(motorista) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM public.monitor_reservas WHERE active = true AND lower(btrim(motorista)) = $1`,
    [motorista.trim().toLowerCase()],
  );
  return rows[0].n;
}

describe("createReserva", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("insere uma reserva ativa com route_key origem→destino", async () => {
    const op = await seedUser({ email: "op-create-reserva@teste.local" });
    const res = await createReserva({
      motorista: "  Joao da Silva ",
      cavalo: "ABC1D23",
      carreta: "DEF4G56",
      origem: " Salvador / BA ",
      destino: " Simoes Filho / BA ",
      operatorId: op.id,
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.id).toBeTruthy();

    const { rows } = await query(
      `SELECT motorista, cavalo, carreta, origem, destino, route_key, status, active FROM public.monitor_reservas WHERE id = $1`,
      [res.payload.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].motorista).toBe("Joao da Silva");
    expect(rows[0].cavalo).toBe("ABC1D23");
    expect(rows[0].origem).toBe("Salvador / BA");
    expect(rows[0].destino).toBe("Simoes Filho / BA");
    expect(rows[0].route_key).toBe("Salvador / BA→Simoes Filho / BA");
    expect(rows[0].status).toBe("RESERVA");
    expect(rows[0].active).toBe(true);
  });

  it("idempotente: mesma rota + mesmo motorista (case-insensitive) retorna a existente sem duplicar", async () => {
    const op = await seedUser({ email: "op-create-reserva-idem@teste.local" });
    const first = await createReserva({
      motorista: "Maria Souza",
      origem: "Salvador / BA",
      destino: "Feira de Santana / BA",
      operatorId: op.id,
      correlationId: "c1",
    });
    const second = await createReserva({
      motorista: "  MARIA souza ",
      origem: "Salvador / BA",
      destino: "Feira de Santana / BA",
      operatorId: op.id,
      correlationId: "c2",
    });

    expect(second.payload.id).toBe(first.payload.id);
    expect(await countActiveReservas("Maria Souza")).toBe(1);
  });

  it("motorista vazio → ValidationError", async () => {
    const op = await seedUser({ email: "op-create-reserva-empty@teste.local" });
    await expect(
      createReserva({ motorista: "   ", origem: "A", destino: "B", operatorId: op.id }),
    ).rejects.toThrow(/motorista/i);
  });

  it("rota vazia → ValidationError", async () => {
    const op = await seedUser({ email: "op-create-reserva-noroute@teste.local" });
    await expect(
      createReserva({ motorista: "Fulano", origem: "", destino: "B", operatorId: op.id }),
    ).rejects.toThrow(/rota/i);
  });
});
