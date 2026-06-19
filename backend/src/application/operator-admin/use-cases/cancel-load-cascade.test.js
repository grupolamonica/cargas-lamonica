import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { cancelLoadCascade } = await import("./cancel-load-cascade.js");

const ROUTE = { origem: "Salvador / BA", destino: "Feira / BA" };

async function seedRouteCargo(lh, { motorista, horario, status, pinned } = {}) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN", origem: ROUTE.origem, destino: ROUTE.destino, horario: horario ?? "08:00:00" });
  await query(
    `UPDATE public.cargas SET sheet_motorista = $2, sheet_status = $3, alloc_pinned = $4 WHERE id = $1`,
    [id, motorista ?? null, status ?? null, pinned ?? false],
  );
  return id;
}

const allocMotorista = async (id) => (await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id])).rows[0].alloc_motorista;
const reservas = async () => (await query(`SELECT * FROM public.monitor_reservas WHERE active = true`)).rows;

describe("cancelLoadCascade", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cascateia: cancelada solta o motorista, o seguinte sobe, o último vira reserva", async () => {
    const c1 = await seedRouteCargo("C1", { motorista: "JOAO", horario: "08:00:00" });
    const c2 = await seedRouteCargo("C2", { motorista: "MARIA", horario: "12:00:00", status: "CANCELADO" });
    const c3 = await seedRouteCargo("C3", { motorista: "PEDRO", horario: "16:00:00" });
    const op = await seedUser({ email: "op-cascade@teste.local" });

    const res = await cancelLoadCascade({ lh: "C2", operatorId: op.id, correlationId: "corr-cascade-1" });

    expect(res.payload.cascaded).toBe(true);
    expect(await allocMotorista(c1)).toBeNull();   // antes da cancelada → intocado
    expect(await allocMotorista(c2)).toBe("");      // cancelada esvazia (morta)
    expect(await allocMotorista(c3)).toBe("MARIA");  // Maria assumiu a próxima

    const r = await reservas();
    expect(r).toHaveLength(1);
    expect(r[0].motorista).toBe("PEDRO");           // o último sobra → reserva
    expect(r[0].route_key).toBe("Salvador / BA→Feira / BA");
    expect(r[0].origin_lh).toBe("C2");
  });

  it("idempotente: rodar de novo não cria reserva duplicada", async () => {
    await seedRouteCargo("D1", { motorista: "JOAO", horario: "08:00:00" });
    await seedRouteCargo("D2", { motorista: "MARIA", horario: "12:00:00", status: "CANCELADO" });
    await seedRouteCargo("D3", { motorista: "PEDRO", horario: "16:00:00" });
    const op = await seedUser({ email: "op-cascade-idem@teste.local" });

    await cancelLoadCascade({ lh: "D2", operatorId: op.id });
    const second = await cancelLoadCascade({ lh: "D2", operatorId: op.id });

    expect(second.payload.cascaded).toBe(false); // já cascateado → no-op
    expect(await reservas()).toHaveLength(1);
  });

  it("se há vaga livre na rota, o motorista preenche e ninguém vai pra reserva", async () => {
    await seedRouteCargo("E1", { motorista: "JOAO", horario: "08:00:00" });
    await seedRouteCargo("E2", { motorista: "MARIA", horario: "12:00:00", status: "CANCELADO" });
    const e3 = await seedRouteCargo("E3", { motorista: null, horario: "16:00:00" }); // vaga
    const op = await seedUser({ email: "op-cascade-vaga@teste.local" });

    const res = await cancelLoadCascade({ lh: "E2", operatorId: op.id });

    expect(res.payload.reserva).toBe(false);
    expect(await allocMotorista(e3)).toBe("MARIA");
    expect(await reservas()).toHaveLength(0);
  });

  it("carga fixa cancelada não cascateia (fixo intocável)", async () => {
    const f1 = await seedRouteCargo("F1", { motorista: "JOAO", horario: "08:00:00" });
    const f2 = await seedRouteCargo("F2", { motorista: "MARIA", horario: "12:00:00", status: "CANCELADO", pinned: true });
    const op = await seedUser({ email: "op-cascade-fixo@teste.local" });

    const res = await cancelLoadCascade({ lh: "F2", operatorId: op.id });

    expect(res.payload.cascaded).toBe(false);
    expect(await reservas()).toHaveLength(0);
    expect(await allocMotorista(f1)).toBeNull();
  });
});
