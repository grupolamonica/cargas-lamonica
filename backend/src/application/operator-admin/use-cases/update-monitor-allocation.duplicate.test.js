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

const DIA = "2026-08-05";
// O audit tem FK para auth.users — o operador precisa existir de verdade.
let OPERADOR;

async function seedLinhaPlanilha(lh, { motorista = null, cavalo = null, horario = "14:00:00", status = "OPEN" } = {}) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status, data: DIA, horario, origem: "A", destino: "B" });
  await query(`UPDATE public.cargas SET sheet_motorista = $2, sheet_cavalo = $3 WHERE id = $1`, [id, motorista, cavalo]);
  return id;
}

describe("updateMonitorAllocation — aviso de duplo-booking", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    writeSpy.mockClear();
    OPERADOR = (await seedUser({ email: "op-dup@teste.local" })).id ?? undefined;
  });
  afterEach(() => { delete process.env.DUPLICATE_ALLOC_WARN; });
  afterAll(async () => { await closeTestDatabase(); });

  it("recusa com 409 acionável quando o motorista já está em outra carga do dia", async () => {
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "Joao Soares de Jesus", cavalo: "GGY0E48", horario: "14:30:00" });
    await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });

    await expect(
      updateMonitorAllocation({
        lh: "LT-DESTINO",
        operatorId: OPERADOR,
        payload: { motorista: "Joao Soares de Jesus", cavalo: "GGY0E48", carreta: "RRH5H94" },
      }),
    ).rejects.toMatchObject({
      name: "ConflictError",
      details: { code: "DUPLICATE_ALLOCATION" },
    });

    // NADA foi gravado e a planilha NÃO foi tocada.
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE sheet_lh = 'LT-DESTINO'`);
    expect(rows[0].alloc_motorista).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("a mensagem do 409 nomeia a carga em conflito e o horário (linguagem do operador)", async () => {
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "Joao Soares de Jesus", horario: "14:30:00" });
    await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });

    const err = await updateMonitorAllocation({
      lh: "LT-DESTINO", operatorId: OPERADOR, payload: { motorista: "Joao Soares de Jesus" },
    }).catch((e) => e);

    expect(err.message).toContain("LT-JA-TEM");
    expect(err.message).toContain("14:30");
    expect(err.message).not.toMatch(/cargo_id|uuid|alloc_/i);
    expect(err.details.conflitos).toHaveLength(1);
  });

  it("confirmDuplicate=true grava (o operador confirmou)", async () => {
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "Joao Soares de Jesus", horario: "14:30:00" });
    await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO",
      operatorId: OPERADOR,
      payload: { motorista: "Joao Soares de Jesus", confirmDuplicate: true },
    });

    expect(r.statusCode).toBe(200);
    const { rows } = await query(`SELECT alloc_motorista FROM public.cargas WHERE sheet_lh = 'LT-DESTINO'`);
    expect(rows[0].alloc_motorista).toBe("Joao Soares de Jesus");
  });

  it("motorista LIVRE não dispara aviso (sem falso positivo)", async () => {
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "OUTRA PESSOA", cavalo: "AAA1A11", horario: "14:30:00" });
    await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO", operatorId: OPERADOR, payload: { motorista: "MOTORISTA LIVRE", cavalo: "BBB2B22" },
    });

    expect(r.statusCode).toBe(200);
  });

  it("RE-SALVAR a mesma alocação não dispara aviso (eco do formulário)", async () => {
    // O editor inline e o modal reenviam os campos pré-preenchidos com o efetivo. Se o
    // eco disparasse aviso, salvar qualquer outro campo pediria confirmação toda vez.
    const id = await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });
    await query(`UPDATE public.cargas SET alloc_motorista = 'CLOVIS', alloc_cavalo = 'AAA1A11' WHERE id = $1`, [id]);
    // Uma outra carga do dia com o MESMO motorista (o estado já existente, herdado).
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "CLOVIS", horario: "14:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO",
      operatorId: OPERADOR,
      payload: { motorista: "CLOVIS", cavalo: "AAA1A11", status: "AGUARDANDO CARREGAMENTO" },
    });

    expect(r.statusCode).toBe(200);
  });

  it("LIMPAR o motorista nunca dispara aviso", async () => {
    const id = await seedLinhaPlanilha("LT-DESTINO");
    await query(`UPDATE public.cargas SET alloc_motorista = 'CLOVIS' WHERE id = $1`, [id]);
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "CLOVIS", horario: "14:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO", operatorId: OPERADOR, payload: { motorista: "", cavalo: "", carreta: "" },
    });

    expect(r.statusCode).toBe(200);
  });

  it("gate off → grava sem avisar (kill-switch)", async () => {
    process.env.DUPLICATE_ALLOC_WARN = "off";
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "Joao Soares de Jesus", horario: "14:30:00" });
    await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO", operatorId: OPERADOR, payload: { motorista: "Joao Soares de Jesus" },
    });

    expect(r.statusCode).toBe(200);
  });

  it("editar SÓ o status numa carga que já tem motorista duplicado não trava o operador", async () => {
    // Regressão importante: o passivo de duplicidade que já existe no banco não pode
    // impedir o operador de mexer no status/tratativas dessas cargas.
    const id = await seedLinhaPlanilha("LT-DESTINO", { horario: "15:30:00" });
    await query(`UPDATE public.cargas SET alloc_motorista = 'CLOVIS' WHERE id = $1`, [id]);
    await seedLinhaPlanilha("LT-JA-TEM", { motorista: "CLOVIS", horario: "14:30:00" });

    const r = await updateMonitorAllocation({
      lh: "LT-DESTINO", operatorId: OPERADOR, payload: { status: "DESCARREGANDO" },
    });

    expect(r.statusCode).toBe(200);
  });
});
