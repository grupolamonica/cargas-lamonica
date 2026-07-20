import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import { expirePastCargas } from "./expire-past-cargas.js";

const deps = { withPgClient };
const statusOf = async (id) => (await query("SELECT status FROM public.cargas WHERE id = $1", [id])).rows[0].status;

describe("expirePastCargas", () => {
  let clienteId;
  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("expira OPEN passada, preserva futura, exceção da lançada-hoje, motorista e recorrente", async () => {
    const hoje = getSaoPauloWallClock().dateIso;

    // 1. sheet carga passada → expira
    const pastSheet = await seedCargo({ cliente_id: clienteId, data: "2020-01-01", horario: "08:00", status: "OPEN", sheet_lh: "LT-OLD" });
    // 2. futura → preserva
    const future = await seedCargo({ cliente_id: clienteId, data: "2999-01-01", horario: "08:00", status: "OPEN" });
    // 3. lançada HOJE (sheet_lh null + lh_manual) c/ horário no passado → exceção: preserva
    const launchedToday = await seedCargo({ cliente_id: clienteId, data: hoje, horario: "00:01", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-TODAY', sheet_lh = NULL WHERE id = $1", [launchedToday.id]);
    // 4. lançada PASSADA → expira (exceção só vale p/ data >= hoje)
    const launchedPast = await seedCargo({ cliente_id: clienteId, data: "2020-01-02", horario: "08:00", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-PAST', sheet_lh = NULL WHERE id = $1", [launchedPast.id]);
    // 5. recorrente passada → preserva (motor de recorrência cuida)
    const recurring = await seedCargo({ cliente_id: clienteId, data: "2020-01-03", horario: "08:00", status: "OPEN", is_recurring: true });
    // 6. passada COM motorista → preserva
    const withDriver = await seedCargo({ cliente_id: clienteId, data: "2020-01-04", horario: "08:00", status: "OPEN" });
    await query("UPDATE public.cargas SET alloc_motorista = 'FULANO' WHERE id = $1", [withDriver.id]);

    const r = await expirePastCargas({ deps });

    expect(r.expired).toBe(2); // pastSheet + launchedPast
    expect(await statusOf(pastSheet.id)).toBe("EXPIRED");
    expect(await statusOf(launchedPast.id)).toBe("EXPIRED");
    expect(await statusOf(future.id)).toBe("OPEN");
    expect(await statusOf(launchedToday.id)).toBe("OPEN");
    expect(await statusOf(recurring.id)).toBe("OPEN");
    expect(await statusOf(withDriver.id)).toBe("OPEN");
  });

  it("expira DRAFT de dia passado (mesmo com motorista), preserva DRAFT de hoje/futuro/recorrente/template", async () => {
    const hoje = getSaoPauloWallClock().dateIso;

    const draftPast = await seedCargo({ cliente_id: clienteId, data: "2020-02-01", horario: "08:00", status: "DRAFT" });
    // DRAFT passado COM sheet_motorista → expira (rascunho não é haul ativo)
    const draftPastDriver = await seedCargo({ cliente_id: clienteId, data: "2020-02-02", horario: "08:00", status: "DRAFT" });
    await query("UPDATE public.cargas SET sheet_motorista = 'FULANO' WHERE id = $1", [draftPastDriver.id]);
    const draftToday = await seedCargo({ cliente_id: clienteId, data: hoje, horario: "00:01", status: "DRAFT" });
    const draftFuture = await seedCargo({ cliente_id: clienteId, data: "2999-01-01", horario: "08:00", status: "DRAFT" });
    const draftRecurring = await seedCargo({ cliente_id: clienteId, data: "2020-02-03", horario: "08:00", status: "DRAFT", is_recurring: true });
    const draftTemplate = await seedCargo({ cliente_id: clienteId, data: "2020-02-04", horario: "08:00", status: "DRAFT", is_template: true });

    const r = await expirePastCargas({ deps });

    expect(r.expired).toBe(2); // draftPast + draftPastDriver
    expect(await statusOf(draftPast.id)).toBe("EXPIRED");
    expect(await statusOf(draftPastDriver.id)).toBe("EXPIRED");
    expect(await statusOf(draftToday.id)).toBe("DRAFT");
    expect(await statusOf(draftFuture.id)).toBe("DRAFT");
    expect(await statusOf(draftRecurring.id)).toBe("DRAFT");
    expect(await statusOf(draftTemplate.id)).toBe("DRAFT");
  });
});
