import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCarga,
  seedCliente,
  seedPacote,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

const { getPublicPacote } = await import("./get-public-pacote.js");
const { NotFoundError } = await import("../../../domain/load-claims/errors.js");

async function seedPacotePublicadoCom3Cargas({ clienteOverrides } = {}) {
  const cliente = await seedCliente({ nome: "Atlas Logistica", ...(clienteOverrides ?? {}) });
  const { id: pacoteId } = await seedPacote({
    status: "publicado",
    valor_total: 18500,
    version: 2,
    published_at: "2026-05-22T10:00:00Z",
  });
  const cargas = [];
  for (let i = 1; i <= 3; i += 1) {
    const { id } = await seedCarga({
      cliente_id: cliente.id,
      viagem_id: pacoteId,
      ordem_viagem: i,
      driver_visibility: "PREMIUM",
      data: `2026-06-0${i + 1}`,
      origem: `Origem ${i}`,
      destino: `Destino ${i}`,
      valor: 1000 * i,
      bonus: 100 * i,
    });
    cargas.push({ id, ordem: i });
  }
  return { pacoteId, cliente, cargas };
}

describe("getPublicPacote (driver-facing)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("retorna pacote publicado com cargas ordenadas por ordem_viagem", async () => {
    const { pacoteId } = await seedPacotePublicadoCom3Cargas();

    const result = await getPublicPacote({ pacoteId, correlationId: "corr-1" });

    expect(result.statusCode).toBe(200);
    expect(result.payload.pacote.id).toBe(pacoteId);
    expect(result.payload.pacote.status).toBe("publicado");
    expect(result.payload.pacote.valor_total).toBe(18500);
    expect(result.payload.pacote.version).toBe(2);
    expect(result.payload.pacote.total_cargas).toBe(3);
    expect(result.payload.pacote.cargas).toHaveLength(3);
    expect(result.payload.pacote.cargas.map((c) => c.ordem_viagem)).toEqual([1, 2, 3]);
    expect(result.payload.pacote.cargas[0].cliente).toMatchObject({ nome: "Atlas Logistica" });
    expect(result.payload.meta.correlationId).toBe("corr-1");
  });

  it("retorna pacote reservado (motorista candidatou) com cargas", async () => {
    const cliente = await seedCliente({ nome: "Reservado SA" });
    const { id: pacoteId } = await seedPacote({ status: "reservado", valor_total: 7000 });
    await seedCarga({ cliente_id: cliente.id, viagem_id: pacoteId, ordem_viagem: 1 });

    const result = await getPublicPacote({ pacoteId });

    expect(result.statusCode).toBe(200);
    expect(result.payload.pacote.status).toBe("reservado");
    expect(result.payload.pacote.cargas).toHaveLength(1);
  });

  it("retorna pacote em_andamento", async () => {
    const { id: pacoteId } = await seedPacote({ status: "em_andamento" });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });

    const result = await getPublicPacote({ pacoteId });

    expect(result.statusCode).toBe(200);
    expect(result.payload.pacote.status).toBe("em_andamento");
  });

  it("lanca NotFoundError quando pacoteId nao existe", async () => {
    await expect(
      getPublicPacote({ pacoteId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lanca NotFoundError quando pacote esta em rascunho (nao vazar info)", async () => {
    const { id: pacoteId } = await seedPacote({ status: "rascunho" });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });

    await expect(getPublicPacote({ pacoteId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lanca NotFoundError quando pacote esta cancelado", async () => {
    const { id: pacoteId } = await seedPacote({ status: "cancelado" });

    await expect(getPublicPacote({ pacoteId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lanca NotFoundError quando pacote esta concluido", async () => {
    const { id: pacoteId } = await seedPacote({ status: "concluido" });

    await expect(getPublicPacote({ pacoteId })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("retorna cargas com cliente=null quando carga nao tem cliente_id", async () => {
    const { id: pacoteId } = await seedPacote({ status: "publicado" });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1, cliente_id: null });

    const result = await getPublicPacote({ pacoteId });

    expect(result.statusCode).toBe(200);
    expect(result.payload.pacote.cargas[0].cliente).toBeNull();
  });

  it("normaliza valor/bonus/distancia_km/duracao_horas para Number", async () => {
    const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 9000 });
    await seedCarga({
      viagem_id: pacoteId,
      ordem_viagem: 1,
      valor: 3000,
      bonus: 250,
    });

    const result = await getPublicPacote({ pacoteId });

    const c = result.payload.pacote.cargas[0];
    expect(typeof c.valor).toBe("number");
    expect(typeof c.bonus).toBe("number");
    expect(c.valor).toBe(3000);
    expect(c.bonus).toBe(250);
  });
});
