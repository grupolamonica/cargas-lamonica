import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { advanceRecurringCargas } = await import("./advance-recurring-cargas.js");

// 2026-06-17 (quarta) ao meio-dia local — estável em UTC e America/Sao_Paulo.
const NOW = new Date(2026, 5, 17, 12, 0, 0);

const isoDateOf = (v) =>
  v instanceof Date
    ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);

async function getCargo(id) {
  const { rows } = await query(`SELECT data, version FROM public.cargas WHERE id = $1`, [id]);
  return rows[0];
}

describe("advanceRecurringCargas (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("avança só as cargas recorrentes OPEN cuja ocorrência já passou", async () => {
    const stale = await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "OPEN", is_recurring: true, recurrence_interval_days: 1 });
    const future = await seedCargo({ data: "2026-06-20", horario: "08:00:00", status: "OPEN", is_recurring: true, recurrence_interval_days: 1 });
    const reserved = await seedCargo({ data: "2026-06-10", horario: "08:00:00", status: "RESERVED", is_recurring: true, recurrence_interval_days: 1 });
    const plain = await seedCargo({ data: "2026-06-10", horario: "08:00:00", status: "OPEN", is_recurring: false });

    const result = await advanceRecurringCargas({ now: NOW });
    expect(result.advanced).toBe(1);

    // stale: 15(passado) -> 16 -> 17(hoje, 09<12 invisível) -> 18 (visível)
    const advancedStale = await getCargo(stale.id);
    expect(isoDateOf(advancedStale.data)).toBe("2026-06-18");
    expect(advancedStale.version).toBe(1); // bump de versão

    // futura visível, reservada, e não-recorrente: intactas
    expect(isoDateOf((await getCargo(future.id)).data)).toBe("2026-06-20");
    expect(isoDateOf((await getCargo(reserved.id)).data)).toBe("2026-06-10");
    expect(isoDateOf((await getCargo(plain.id)).data)).toBe("2026-06-10");
  });

  it("respeita o intervalo configurável (a cada 7 dias)", async () => {
    const weekly = await seedCargo({ data: "2026-06-10", horario: "08:00:00", status: "OPEN", is_recurring: true, recurrence_interval_days: 7 });
    await advanceRecurringCargas({ now: NOW });
    // 10 -> 17 (hoje, 08<12 invisível) -> 24
    expect(isoDateOf((await getCargo(weekly.id)).data)).toBe("2026-06-24");
  });

  it("é idempotente: a 2ª execução não avança nada", async () => {
    await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "OPEN", is_recurring: true, recurrence_interval_days: 1 });
    expect((await advanceRecurringCargas({ now: NOW })).advanced).toBe(1);
    expect((await advanceRecurringCargas({ now: NOW })).advanced).toBe(0);
  });
});
