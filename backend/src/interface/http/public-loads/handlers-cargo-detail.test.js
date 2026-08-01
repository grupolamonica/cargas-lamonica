/**
 * GET /api/driver/cargas/:cargoId — contrato HTTP do detalhe da carga.
 *
 * Este endpoint substitui as leituras diretas que a tela /motorista/cargas/:id
 * fazia no banco com a chave anônima. Aqui travamos o contrato que o frontend
 * passou a depender: 200 com { cargo, routeFallback, historyDistanciaKm },
 * 404 para carga fora dos status públicos e 422 para cargoId não-UUID (antes,
 * um id inválido virava erro 22P02 do PostgREST no navegador — em ambos os
 * casos a tela cai no mesmo ErrorState).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedRoute,
  withPgClient,
  withPgTransaction,
} from "../../../application/operator-admin/test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

// Bypass do sheet-sync (depende de SUPABASE_*); o módulo de handlers o importa.
vi.mock("../../../infrastructure/supabase/admin-client.js", () => ({
  createSupabaseAdminClient: () => null,
}));

vi.mock("../../../application/google-sheets/google-sheet-loads.js", () => ({
  syncGoogleSheetLoads: vi.fn().mockResolvedValue({ availableLoadsCount: 0, unlinkedLoadsCount: 0 }),
}));

const { resolveDriverCargoDetailResponse } = await import("./handlers.js");
const { __resetDriverCargoDetailCache } = await import(
  "../../../application/operator-admin/use-cases/dashboard-read-model.js"
);

/** Espelha o estado pós-`withParams` do routes.js (params mesclados em query). */
function mockRequest(params = {}) {
  return { params, query: { ...params }, headers: {} };
}

const CARGO_ID = "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa";

describe("GET /api/driver/cargas/:cargoId", () => {
  let clienteId;

  beforeEach(async () => {
    await resetTestDatabase();
    __resetDriverCargoDetailCache();
    const cliente = await seedCliente({ nome: "Embarcador HTTP" });
    clienteId = cliente.id;
    await seedRoute({ tempo_estimado_horas: 26 });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("200 com o detalhe completo da carga visível", async () => {
    await seedCargo({ id: CARGO_ID, cliente_id: clienteId, status: "OPEN", data: "2099-06-02" });

    const response = await resolveDriverCargoDetailResponse(mockRequest({ cargoId: CARGO_ID }));

    expect(response.statusCode).toBe(200);
    expect(response.payload.cargo.id).toBe(CARGO_ID);
    expect(response.payload.cargo.cliente.nome).toBe("Embarcador HTTP");
    expect(response.payload.routeFallback).not.toBeNull();
    expect(response.payload).toHaveProperty("historyDistanciaKm");
    expect(response.payload.meta.correlationId).toBeTruthy();
  });

  it("404 para carga em status que a policy anônima não liberava", async () => {
    await seedCargo({ id: CARGO_ID, cliente_id: clienteId, status: "DRAFT" });

    const response = await resolveDriverCargoDetailResponse(mockRequest({ cargoId: CARGO_ID }));

    expect(response.statusCode).toBe(404);
    expect(response.payload.code).toBe("CARGO_NOT_FOUND");
  });

  it("422 quando o cargoId não é UUID (não chega a consultar o banco)", async () => {
    const response = await resolveDriverCargoDetailResponse(mockRequest({ cargoId: "nao-e-uuid" }));

    expect(response.statusCode).toBe(422);
  });

  it("422 quando o cargoId está ausente", async () => {
    const response = await resolveDriverCargoDetailResponse(mockRequest({}));

    expect(response.statusCode).toBe(422);
  });
});
