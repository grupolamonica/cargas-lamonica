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

const LH = "LT-CONC-1";
let DANIELE;
let SINARA;

async function seedLinha() {
  const id = createSheetLoadId(LH);
  await seedCargo({ id, sheet_lh: LH, status: "OPEN", origem: "A", destino: "B" });
  return id;
}

/** Carimbo atual de alloc_updated_at, como o front leria via allocByLh. */
async function carimboAtual(id) {
  const { rows } = await query(`SELECT alloc_updated_at FROM public.cargas WHERE id = $1`, [id]);
  const v = rows[0].alloc_updated_at;
  return v instanceof Date ? v.toISOString() : v;
}

describe("updateMonitorAllocation — aviso de edição simultânea", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    writeSpy.mockClear();
    DANIELE = (await seedUser({ email: "daniele@teste.local" })).id;
    SINARA = (await seedUser({ email: "sinara@teste.local" })).id;
  });
  afterEach(() => { delete process.env.CONCURRENT_EDIT_WARN; });
  afterAll(async () => { await closeTestDatabase(); });

  it("reproduz o ping-pong de 05/08 e INTERCEPTA a sobrescrita cega", async () => {
    const id = await seedLinha();

    // Daniele abre a tela e vê o estado inicial (nunca alterado).
    const baselineDaniele = await carimboAtual(id); // null

    // Sinara grava primeiro (ela tinha a tela fresca).
    await updateMonitorAllocation({
      lh: LH, operatorId: SINARA,
      payload: { motorista: "ELEONALDO LOPES DA SILVA", expectedAllocUpdatedAt: baselineDaniele },
    });

    // Daniele salva com o baseline VELHO — antes isto sobrescrevia em silêncio.
    const err = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE,
      payload: { motorista: "Joao Soares de Jesus", expectedAllocUpdatedAt: baselineDaniele },
    }).catch((e) => e);

    expect(err.name).toBe("ConflictError");
    expect(err.details.code).toBe("ALLOCATION_CHANGED");
    // A mensagem diz o que está lá agora, para a decisão ser informada.
    expect(err.message).toContain("ELEONALDO LOPES DA SILVA");
    expect(err.details.atual.motorista).toBe("ELEONALDO LOPES DA SILVA");
    // E o valor da Sinara continua no banco — nada foi sobrescrito.
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_motorista).toBe("ELEONALDO LOPES DA SILVA");
  });

  it("confirmOverwrite=true sobrescreve (o operador decidiu)", async () => {
    const id = await seedLinha();
    const baseline = await carimboAtual(id);
    await updateMonitorAllocation({
      lh: LH, operatorId: SINARA, payload: { motorista: "ELEONALDO", expectedAllocUpdatedAt: baseline },
    });

    const r = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE,
      payload: { motorista: "Joao Soares de Jesus", expectedAllocUpdatedAt: baseline, confirmOverwrite: true },
    });

    expect(r.statusCode).toBe(200);
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_motorista).toBe("Joao Soares de Jesus");
  });

  it("o carimbo devolvido na resposta serve de baseline do save SEGUINTE (sem falso aviso)", async () => {
    // Regressão da armadilha: se o front usasse um timestamp gerado no cliente, o 2º
    // save do mesmo modal sempre acusaria edição simultânea inexistente.
    const id = await seedLinha();
    const primeiro = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE, payload: { motorista: "CLOVIS", expectedAllocUpdatedAt: null },
    });

    expect(primeiro.payload.allocUpdatedAt).toBeTruthy();
    expect(primeiro.payload.allocUpdatedAt).toBe(await carimboAtual(id));

    const segundo = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE,
      payload: { motorista: "CLOVIS", status: "DESCARREGANDO", expectedAllocUpdatedAt: primeiro.payload.allocUpdatedAt },
    });

    expect(segundo.statusCode).toBe(200);
  });

  it("SEM baseline no payload → checagem pulada (editor inline, aba antiga, automação)", async () => {
    const id = await seedLinha();
    await updateMonitorAllocation({ lh: LH, operatorId: SINARA, payload: { motorista: "ELEONALDO" } });

    const r = await updateMonitorAllocation({ lh: LH, operatorId: DANIELE, payload: { motorista: "Joao" } });

    expect(r.statusCode).toBe(200);
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_motorista).toBe("Joao");
  });

  it("baseline CORRETO (ninguém mexeu no meio) → grava sem avisar", async () => {
    const id = await seedLinha();
    const baseline = await carimboAtual(id);

    const r = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE, payload: { motorista: "CLOVIS", expectedAllocUpdatedAt: baseline },
    });

    expect(r.statusCode).toBe(200);
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_motorista).toBe("CLOVIS");
  });

  it("gate off → sobrescreve sem avisar (kill-switch)", async () => {
    process.env.CONCURRENT_EDIT_WARN = "off";
    const id = await seedLinha();
    const baseline = await carimboAtual(id);
    await updateMonitorAllocation({
      lh: LH, operatorId: SINARA, payload: { motorista: "ELEONALDO", expectedAllocUpdatedAt: baseline },
    });

    const r = await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE, payload: { motorista: "Joao", expectedAllocUpdatedAt: baseline },
    });

    expect(r.statusCode).toBe(200);
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_motorista).toBe("Joao");
  });

  it("nada é gravado nem espelhado na planilha quando o aviso dispara", async () => {
    const id = await seedLinha();
    const baseline = await carimboAtual(id);
    await updateMonitorAllocation({
      lh: LH, operatorId: SINARA, payload: { motorista: "ELEONALDO", expectedAllocUpdatedAt: baseline },
    });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: LH, operatorId: DANIELE, payload: { motorista: "Joao", cavalo: "AAA1A11", expectedAllocUpdatedAt: baseline },
    }).catch(() => {});

    expect(writeSpy).not.toHaveBeenCalled();
    const { rows } = await query(`SELECT alloc_cavalo FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_cavalo).toBeNull();
  });
});
