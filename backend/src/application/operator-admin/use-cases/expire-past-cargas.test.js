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

  it("carga LANÇADA recente NÃO expira (janela de graça — não sai de /cargas/Monitor); planilha/lançada-antiga expira; preserva futura/motorista/recorrente", async () => {
    const hoje = getSaoPauloWallClock().dateIso;

    // 1. sheet carga passada → expira (não é lançada; sem janela de graça)
    const pastSheet = await seedCargo({ cliente_id: clienteId, data: "2020-01-01", horario: "08:00", status: "OPEN", sheet_lh: "LT-OLD" });
    // 2. futura → preserva
    const future = await seedCargo({ cliente_id: clienteId, data: "2999-01-01", horario: "08:00", status: "OPEN" });
    // 3. lançada HOJE (sheet_lh null + lh_manual) c/ horário no passado → JANELA DE
    //    GRAÇA: NÃO expira no mesmo dia (fica visível p/ o operador). Pedido: a carga
    //    lançada não pode SAIR de /cargas e Monitor.
    const launchedToday = await seedCargo({ cliente_id: clienteId, data: hoje, horario: "00:01", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-TODAY', sheet_lh = NULL WHERE id = $1", [launchedToday.id]);
    // 4. lançada FUTURA → preserva
    const launchedFuture = await seedCargo({ cliente_id: clienteId, data: "2999-01-02", horario: "08:00", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-FUT', sheet_lh = NULL WHERE id = $1", [launchedFuture.id]);
    // 5. lançada ANTIGA (2020, muito além da janela de graça) → expira
    const launchedPast = await seedCargo({ cliente_id: clienteId, data: "2020-01-02", horario: "08:00", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-PAST', sheet_lh = NULL WHERE id = $1", [launchedPast.id]);
    // 6. recorrente passada → preserva (motor de recorrência cuida)
    const recurring = await seedCargo({ cliente_id: clienteId, data: "2020-01-03", horario: "08:00", status: "OPEN", is_recurring: true });
    // 7. passada COM motorista → preserva
    const withDriver = await seedCargo({ cliente_id: clienteId, data: "2020-01-04", horario: "08:00", status: "OPEN" });
    await query("UPDATE public.cargas SET alloc_motorista = 'FULANO' WHERE id = $1", [withDriver.id]);

    const r = await expirePastCargas({ deps });

    expect(r.expired).toBe(2); // pastSheet + launchedPast (launchedToday fica na graça)
    expect(await statusOf(pastSheet.id)).toBe("EXPIRED");
    expect(await statusOf(launchedPast.id)).toBe("EXPIRED");
    expect(await statusOf(launchedToday.id)).toBe("OPEN"); // graça: não sai das telas
    expect(await statusOf(future.id)).toBe("OPEN");
    expect(await statusOf(launchedFuture.id)).toBe("OPEN");
    expect(await statusOf(recurring.id)).toBe("OPEN");
    expect(await statusOf(withDriver.id)).toBe("OPEN");
  });

  it("carga 'a confirmar' (agenda placeholder) NUNCA expira pelo horário — mesmo antiga", async () => {
    // Placeholder: data=hoje/horario 00:00 (ou até uma data passada) + agenda_a_confirmar.
    // Sem o guard, expira em ≤15min (00:00 < agora) e some antes de o operador confirmar.
    const aConfirmarToday = await seedCargo({ cliente_id: clienteId, data: getSaoPauloWallClock().dateIso, horario: "00:00", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-AC1', sheet_lh = NULL, agenda_a_confirmar = true WHERE id = $1", [aConfirmarToday.id]);
    const aConfirmarOld = await seedCargo({ cliente_id: clienteId, data: "2020-03-01", horario: "00:00", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-AC2', sheet_lh = NULL, agenda_a_confirmar = true WHERE id = $1", [aConfirmarOld.id]);

    const r = await expirePastCargas({ deps });

    expect(await statusOf(aConfirmarToday.id)).toBe("OPEN");
    expect(await statusOf(aConfirmarOld.id)).toBe("OPEN"); // guard de a_confirmar vence a janela de graça
    expect(r.expired).toBe(0);
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
