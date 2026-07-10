import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { updateOperatorCargo } = await import("./update-cargo.js");

const updatePayload = (over = {}) => ({
  data: "2026-08-01",
  horario: "08:00:00",
  origem: "Sao Paulo / SP",
  destino: "Simoes Filho / BA",
  perfil: "CARRETA",
  eixos: null,
  valor: 5000,
  bonus: 0,
  bonus_exigencias: null,
  driver_visibility: "PUBLIC",
  cliente_id: null,
  status: "OPEN",
  is_template: false,
  is_recurring: false,
  recurrence_interval_days: null,
  distancia_km: 100,
  duracao_horas: 2,
  sheet_data_carregamento: null,
  sheet_data_descarga: null,
  codigo_viagem: null,
  ...over,
});

describe("cliente de carga de planilha na edição", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("preserva o cliente da fonte (Nestlé) ao editar — não força o cliente default (Shopee)", async () => {
    const op = await seedUser({ email: "op-sheet-client-1@teste.local" });
    const shopee = await seedCliente({ nome: "Shopee" }); // cliente default da planilha
    const nestle = await seedCliente({ nome: "Produtos Alimentícios" });
    const cargo = await seedCargo({
      sheet_lh: "LT-NESTLE-1",
      cliente_id: nestle.id,
      origem: "Sao Paulo / SP",
      destino: "Simoes Filho / BA",
    });

    // O payload manda OUTRO cliente (ruído). A carga é de planilha (sheet_lh) →
    // o cliente da própria carga deve ser preservado, não forçado ao default.
    const res = await updateOperatorCargo({
      cargoId: cargo.id,
      operatorId: op.id,
      payload: updatePayload({ cliente_id: shopee.id }),
      correlationId: "c-sheet-client-1",
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await query(`SELECT cliente_id FROM public.cargas WHERE id = $1`, [cargo.id]);
    expect(rows[0].cliente_id).toBe(nestle.id);
  });

  it("carga de planilha SEM cliente cai no cliente default da planilha", async () => {
    const op = await seedUser({ email: "op-sheet-client-2@teste.local" });
    const shopee = await seedCliente({ nome: "Shopee" });
    const cargo = await seedCargo({ sheet_lh: "LT-NOCLIENT-1", cliente_id: null });

    const res = await updateOperatorCargo({
      cargoId: cargo.id,
      operatorId: op.id,
      payload: updatePayload({ cliente_id: null }),
      correlationId: "c-sheet-client-2",
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await query(`SELECT cliente_id FROM public.cargas WHERE id = $1`, [cargo.id]);
    expect(rows[0].cliente_id).toBe(shopee.id);
  });
});
