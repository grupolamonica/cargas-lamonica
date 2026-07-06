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

// Instante FIXO em UTC = 2026-06-17 12:00 BRT (UTC-3). advanceRecurringCargas
// usa getSaoPauloWallClock, então cravamos o instante em UTC p/ determinismo.
const NOW = new Date("2026-06-17T15:00:00Z");

const isoDateOf = (v) =>
  v instanceof Date
    ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);

async function getCargo(id) {
  const { rows } = await query(`SELECT data, version, sheet_data_carregamento FROM public.cargas WHERE id = $1`, [id]);
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
    // rótulo de carregamento acompanha a nova data (seedCargo já preenche o campo)
    expect(advancedStale.sheet_data_carregamento).toBe("2026-06-18T09:00");

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

  // ── Auto-cura: cadeias recorrentes órfãs (clone-on-reserve falho/interrompido) ──

  it("revive cadeia órfã: recorrente reservada, vencida e sem sucessora OPEN → cria próxima OPEN", async () => {
    // Espelha o caso de prod: cauda RESERVED, is_recurring=false, mas o intervalo
    // ficou setado — nem o clone nem o avanço a resgatam.
    const orphan = await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "RESERVED", is_recurring: false, recurrence_interval_days: 1 });

    const result = await advanceRecurringCargas({ now: NOW });
    expect(result.revived).toBe(1);

    // A carga órfã original NÃO é modificada (continua RESERVED).
    const orig = await query(`SELECT status FROM public.cargas WHERE id = $1`, [orphan.id]);
    expect(orig.rows[0].status).toBe("RESERVED");

    // Nasce UMA sucessora OPEN recorrente, na próxima ocorrência visível, ligada à cadeia.
    const succ = await query(
      `SELECT data, sheet_data_carregamento, is_recurring, recurrence_interval_days, recurrence_parent_id FROM public.cargas WHERE status = 'OPEN' AND is_recurring = true`,
    );
    expect(succ.rows.length).toBe(1);
    expect(isoDateOf(succ.rows[0].data)).toBe("2026-06-18"); // 15→16→17(09<12 invisível)→18
    // rótulo derivado da data/horário da sucessora (não copiado da cauda defasada)
    expect(succ.rows[0].sheet_data_carregamento).toBe("2026-06-18T09:00");
    expect(Number(succ.rows[0].recurrence_interval_days)).toBe(1);
    expect(succ.rows[0].recurrence_parent_id).toBe(orphan.id);
  });

  it("auto-cura é idempotente: 2ª execução não duplica a sucessora", async () => {
    await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "RESERVED", is_recurring: false, recurrence_interval_days: 1 });
    expect((await advanceRecurringCargas({ now: NOW })).revived).toBe(1);
    expect((await advanceRecurringCargas({ now: NOW })).revived).toBe(0);
    const { rows } = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE status = 'OPEN' AND is_recurring = true`);
    expect(rows[0].n).toBe(1);
  });

  it("NÃO revive cadeia que ainda tem carga OPEN (o avanço já cuida)", async () => {
    const root = await seedCargo({ data: "2026-06-20", horario: "08:00:00", status: "OPEN", is_recurring: true, recurrence_interval_days: 1 });
    const reservedTail = await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "RESERVED", is_recurring: false, recurrence_interval_days: 1 });
    await query(`UPDATE public.cargas SET recurrence_parent_id = $1 WHERE id = $2`, [root.id, reservedTail.id]);
    expect((await advanceRecurringCargas({ now: NOW })).revived).toBe(0);
  });

  it("NÃO revive cadeia cuja cauda expirou/cancelou (pode ter sido encerrada de propósito)", async () => {
    await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "EXPIRED", is_recurring: false, recurrence_interval_days: 1 });
    await seedCargo({ data: "2026-06-15", horario: "09:00:00", status: "CANCELLED", is_recurring: false, recurrence_interval_days: 1 });
    expect((await advanceRecurringCargas({ now: NOW })).revived).toBe(0);
  });

  it("NÃO revive cadeia cuja cauda ainda está no futuro (a próxima não venceu)", async () => {
    await seedCargo({ data: "2026-06-25", horario: "08:00:00", status: "RESERVED", is_recurring: false, recurrence_interval_days: 1 });
    expect((await advanceRecurringCargas({ now: NOW })).revived).toBe(0);
  });
});
