import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedUser,
  withPgClient,
} from "../test-harness.js";

import { launchCargoFromTrip } from "./launch-cargo-from-trip.js";

const deps = { withPgClient };

const validTrip = {
  lh: "LT1ABC",
  origem: "SAO PAULO SP",
  destino: "CAMPINAS SP",
  data: "2026-07-20",
  horario: "08:00",
};

describe("launchCargoFromTrip", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    delete process.env.GOOGLE_SHEET_DEFAULT_CLIENT_NAME; // findSheetClientId → "Shopee"
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("lança nova carga OPEN, LH em lh_manual (NÃO sheet_lh) + cliente Shopee", async () => {
    const cliente = await seedCliente({ nome: "Shopee" });
    const op = await seedUser({ email: "op-prog@test.local" });

    const res = await launchCargoFromTrip({ ...validTrip, operatorId: op.id, correlationId: "c1", deps });

    expect(res.statusCode).toBe(201);
    expect(res.payload.alreadyExists).toBe(false);

    const { rows } = await query(
      "SELECT sheet_lh, lh_manual, status, cliente_id, origem, destino, perfil, sheet_data_carregamento, sheet_synced_at, is_template, driver_visibility FROM public.cargas WHERE id = $1",
      [res.payload.id],
    );
    // LH vai em lh_manual; sheet_lh/sheet_synced_at ficam nulos (não é carga do sync).
    expect(rows[0].lh_manual).toBe("LT1ABC");
    expect(rows[0].sheet_lh).toBeNull();
    expect(rows[0].sheet_synced_at).toBeNull();
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].cliente_id).toBe(cliente.id);
    expect(rows[0].origem).toBe("SAO PAULO SP");
    expect(rows[0].perfil).toBe("CARRETA");
    expect(rows[0].sheet_data_carregamento).toBe("2026-07-20T08:00");
    expect(rows[0].is_template).toBe(false);
    expect(rows[0].driver_visibility).toBe("PUBLIC");
  });

  it("idempotente: carga da planilha (sheet_lh) com o mesmo LH → devolve a existente", async () => {
    await seedCliente({ nome: "Shopee" });
    const existing = await seedCargo({ sheet_lh: "LT1ABC", status: "OPEN", origem: "X", destino: "Y" });

    const res = await launchCargoFromTrip({ ...validTrip, correlationId: "c2", deps });

    expect(res.statusCode).toBe(200);
    expect(res.payload.alreadyExists).toBe(true);
    expect(res.payload.id).toBe(existing.id);

    const { rows } = await query("SELECT id FROM public.cargas WHERE sheet_lh = $1 OR lh_manual = $1", ["LT1ABC"]);
    expect(rows).toHaveLength(1);
  });

  it("idempotente: relançar o mesmo LH (lh_manual) não cria carga duplicada", async () => {
    await seedCliente({ nome: "Shopee" });
    const first = await launchCargoFromTrip({ ...validTrip, correlationId: "c3", deps });
    const second = await launchCargoFromTrip({ ...validTrip, correlationId: "c4", deps });

    expect(second.payload.alreadyExists).toBe(true);
    expect(second.payload.id).toBe(first.payload.id);
    const { rows } = await query("SELECT id FROM public.cargas WHERE lh_manual = $1", ["LT1ABC"]);
    expect(rows).toHaveLength(1);
  });

  it("rejeita quando o cliente Shopee não está cadastrado", async () => {
    // sem seedCliente → findSheetClientId devolve null
    await expect(launchCargoFromTrip({ ...validTrip, deps })).rejects.toThrow(/Shopee/);
  });

  it("sem data → lança 'a confirmar' (placeholder + flag), não rejeita", async () => {
    await seedCliente({ nome: "Shopee" });
    const res = await launchCargoFromTrip({ ...validTrip, data: "", horario: "", dataDescarga: "", deps });

    expect(res.statusCode).toBe(201);
    expect(res.payload.aConfirmar).toBe(true);
    const { rows } = await query(
      "SELECT agenda_a_confirmar, sheet_data_carregamento, sheet_data_descarga, horario, status FROM public.cargas WHERE id = $1",
      [res.payload.id],
    );
    expect(rows[0].agenda_a_confirmar).toBe(true);
    expect(rows[0].sheet_data_carregamento).toBe("A confirmar");
    expect(rows[0].sheet_data_descarga).toBeNull();
    expect(rows[0].status).toBe("OPEN");
  });

  it("rejeita origem/destino ausentes", async () => {
    await seedCliente({ nome: "Shopee" });
    await expect(launchCargoFromTrip({ ...validTrip, origem: "", deps })).rejects.toThrow();
  });

  it("rejeita LH vazio", async () => {
    await expect(launchCargoFromTrip({ ...validTrip, lh: "  ", deps })).rejects.toThrow();
  });
});
