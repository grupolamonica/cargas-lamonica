import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { writeSpy } = vi.hoisted(() => ({ writeSpy: vi.fn(async () => {}) }));
vi.mock("../../google-sheets/sheet-writeback.js", async (importOriginal) => ({
  ...(await importOriginal()),
  writeAllocationsToSheet: writeSpy,
}));

const { updateMonitorAllocation } = await import("./update-monitor-allocation.js");
const { mergeLaunchedTwinAlloc } = await import("./merge-launched-twin.js");

// Reproduz o cenário real: cancelar pelo LH de uma carga que resolve para a
// CANÔNICA da planilha porque uma gêmea lançada foi mergeada nela. Antes do merge,
// esse mesmo LH resolvia para a lançada (isSystemCargo=true) e NUNCA cascateava —
// a fila de rota (cancelLoadCascade) só considera cargas da planilha. Preservar
// esse comportamento é o que a flag `viaTwinMerge` faz.
//
// NOTA: cancelLoadCascade resolve a carga-gatilho por `createSheetLoadId(lh)`
// diretamente (não pelo resolvedor canônico compartilhado) — por isso as cargas
// da planilha aqui usam esse id determinístico, igual ao teste de cascata em
// update-monitor-allocation.test.js.
describe("updateMonitorAllocation — cascata de cancelamento × gêmea mergeada", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    writeSpy.mockClear();
  });
  afterEach(() => {
    delete process.env.TWIN_MERGE;
    delete process.env.TWIN_CASCADE_ON_MERGED;
  });
  afterAll(async () => { await closeTestDatabase(); });

  async function seedFilaComGemeaMergeada() {
    // Fila DESC: CASC-B(10h, topo) · CASC-A(08h, base). MOT A na base direto na
    // planilha; MOT B só existe na gêmea LANÇADA, migrada pro topo pelo merge.
    const idA = createSheetLoadId("CASC-A");
    const idB = createSheetLoadId("CASC-B");
    await seedCargo({ id: idA, sheet_lh: "CASC-A", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA", horario: "08:00:00" });
    await seedCargo({ id: idB, sheet_lh: "CASC-B", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA", horario: "10:00:00" });
    await query(`UPDATE public.cargas SET sheet_motorista = 'MOT A' WHERE id = $1`, [idA]);
    const { id: idBLancada } = await seedCargo({ sheet_lh: null, origem: "Salvador / BA", destino: "Feira / BA", status: "RESERVED" });
    await query(
      `UPDATE public.cargas SET lh_manual = 'CASC-B', alloc_motorista = 'MOT B', alloc_updated_at = now() WHERE id = $1`,
      [idBLancada],
    );

    process.env.TWIN_MERGE = "on";
    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh: "CASC-B", winnerId: idB }));
    expect(r.merged).toBe(true);
    const winner = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [idB]);
    expect(winner.rows[0].alloc_motorista).toBe("MOT B"); // confirma que o merge aconteceu

    return { idA, idB };
  }

  it("SEM o gate de cascata: cancelar a gêmea mergeada não move a fila (comportamento preservado)", async () => {
    const { idA, idB } = await seedFilaComGemeaMergeada();
    const operator = await seedUser({ email: "op-twin-cascade-off@teste.local" });

    const result = await updateMonitorAllocation({
      lh: "CASC-B",
      operatorId: operator.id,
      payload: { status: "CANCELADO" },
      correlationId: "corr-twin-cascade-off",
    });

    expect(result.movedLhs).toEqual([]);
    const b = await query(`SELECT alloc_status, alloc_motorista FROM public.cargas WHERE id = $1`, [idB]);
    expect(b.rows[0].alloc_status).toBe("CANCELADO");
    // A cascata NÃO rodou: MOT A (via sheet_motorista, nunca sobrescrito) continua
    // na base, ninguém foi pra reserva.
    const a = await query(`SELECT COALESCE(alloc_motorista, sheet_motorista, '') AS motorista FROM public.cargas WHERE id = $1`, [idA]);
    expect(a.rows[0].motorista).toBe("MOT A");
    const reservas = await query(`SELECT motorista FROM public.monitor_reservas WHERE active = true`);
    expect(reservas.rows).toHaveLength(0);
  });

  it("COM TWIN_CASCADE_ON_MERGED=true: a cascata passa a rodar (decisão explícita)", async () => {
    const { idA } = await seedFilaComGemeaMergeada();
    process.env.TWIN_CASCADE_ON_MERGED = "true";
    const operator = await seedUser({ email: "op-twin-cascade-on@teste.local" });

    const result = await updateMonitorAllocation({
      lh: "CASC-B",
      operatorId: operator.id,
      payload: { status: "CANCELADO" },
      correlationId: "corr-twin-cascade-on",
    });

    expect(result.movedLhs.length).toBeGreaterThan(0);
    const a = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [idA]);
    expect(a.rows[0].alloc_motorista).toBe("MOT B"); // desceu de verdade
    const reservas = await query(`SELECT motorista FROM public.monitor_reservas WHERE active = true`);
    expect(reservas.rows.map((r) => r.motorista)).toContain("MOT A");
  });

  it("cancelamento de carga da planilha SEM gêmea segue cascateando normalmente (regressão)", async () => {
    process.env.TWIN_MERGE = "on"; // exercita o resolvedor canônico mesmo sem par
    const idA = createSheetLoadId("CASC-A2");
    const idB = createSheetLoadId("CASC-B2");
    await seedCargo({ id: idA, sheet_lh: "CASC-A2", status: "OPEN", origem: "Recife / PE", destino: "Caruaru / PE", horario: "08:00:00" });
    await seedCargo({ id: idB, sheet_lh: "CASC-B2", status: "OPEN", origem: "Recife / PE", destino: "Caruaru / PE", horario: "10:00:00" });
    await query(`UPDATE public.cargas SET sheet_motorista = 'MOT A' WHERE id = $1`, [idA]);
    await query(`UPDATE public.cargas SET sheet_motorista = 'MOT B' WHERE id = $1`, [idB]);
    const operator = await seedUser({ email: "op-twin-cascade-nogemea@teste.local" });

    const result = await updateMonitorAllocation({
      lh: "CASC-B2",
      operatorId: operator.id,
      payload: { status: "CANCELADO" },
      correlationId: "corr-twin-cascade-nogemea",
    });

    expect(result.movedLhs.length).toBeGreaterThan(0);
    const a = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [idA]);
    expect(a.rows[0].alloc_motorista).toBe("MOT B");
  });
});
