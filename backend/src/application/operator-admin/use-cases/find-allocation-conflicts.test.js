import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, query, resetTestDatabase, seedCargo, withPgTransaction } from "../test-harness.js";
import { describeConflicts, duplicateAllocWarnEnabled, findAllocationConflicts } from "./find-allocation-conflicts.js";

const DIA = "2026-08-05";
const OUTRO_DIA = "2026-08-06";

/** Carga viva com alocação efetiva (alloc_* ou sheet_*). */
async function seedComAlocacao({ lh = null, lhManual = null, motorista = null, cavalo = null, data = DIA, horario = "14:00:00", status = "RESERVED", allocStatus = null, sheetStatus = null, sheetMotorista = null } = {}) {
  const { id } = await seedCargo({ sheet_lh: lh, data, horario, status, origem: "A", destino: "B" });
  await query(
    `UPDATE public.cargas
        SET lh_manual = $2, alloc_motorista = $3, alloc_cavalo = $4,
            alloc_status = $5, sheet_status = $6, sheet_motorista = $7
      WHERE id = $1`,
    [id, lhManual, motorista, cavalo, allocStatus, sheetStatus, sheetMotorista],
  );
  return id;
}

const buscar = (args) => withPgTransaction((client) => findAllocationConflicts(client, args));

describe("findAllocationConflicts", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterEach(() => { delete process.env.DUPLICATE_ALLOC_WARN; });
  afterAll(async () => { await closeTestDatabase(); });

  it("acusa o MESMO motorista em outra carga do mesmo dia", async () => {
    // O incidente real: LT0Q8502CP7S1 (14:30) e LT0Q8502CP7W1 (15:30), mesma rota,
    // ambas com Joao Soares de Jesus.
    await seedComAlocacao({ lh: "LT-OUTRA", motorista: "Joao Soares de Jesus", cavalo: "GGY0E48", horario: "14:30:00" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO", horario: "15:30:00" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "Joao Soares de Jesus" });

    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ lh: "LT-OUTRA", conflitaMotorista: true, horario: "14:30" });
  });

  it("acusa a MESMA placa mesmo com motorista diferente", async () => {
    await seedComAlocacao({ lh: "LT-OUTRA", motorista: "OUTRA PESSOA", cavalo: "GGY0E48" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, cavalo: "ggy-0e48" });

    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ conflitaCavalo: true, conflitaMotorista: false });
  });

  it("NÃO acusa em dia diferente", async () => {
    await seedComAlocacao({ lh: "LT-OUTRA", motorista: "Joao Soares de Jesus", data: OUTRO_DIA });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO", data: DIA });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "Joao Soares de Jesus" });

    expect(c).toEqual([]);
  });

  it("NÃO acusa a própria carga nem a GÊMEA do mesmo LH", async () => {
    // A gêmea lançada e a canônica da planilha são a MESMA viagem: sem esta exclusão,
    // editar uma acusaria conflito com a outra — o falso-positivo mais óbvio possível.
    const alvo = await seedComAlocacao({ lh: "LT-MESMO", motorista: "CLOVIS" });
    await seedComAlocacao({ lhManual: "LT-MESMO", motorista: "CLOVIS" });

    const c = await buscar({ cargoId: alvo, lh: "LT-MESMO", data: DIA, motorista: "CLOVIS" });

    expect(c).toEqual([]);
  });

  it("NÃO acusa carga em status TERMINAL", async () => {
    await seedComAlocacao({ lh: "LT-MORTA", motorista: "CLOVIS", status: "EXPIRED" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "CLOVIS" });

    expect(c).toEqual([]);
  });

  it("NÃO acusa carga com status operacional de CANCELAMENTO", async () => {
    await seedComAlocacao({ lh: "LT-CANC", motorista: "CLOVIS", allocStatus: "CANCELADO" });
    await seedComAlocacao({ lh: "LT-NOSHOW", motorista: "CLOVIS", sheetStatus: "NO SHOW" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "CLOVIS" });

    expect(c).toEqual([]);
  });

  it("casa o motorista da PLANILHA (sheet_motorista) quando não há override", async () => {
    await seedComAlocacao({ lh: "LT-OUTRA", sheetMotorista: "Joao Soares de Jesus" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "JOAO SOARES DE JESUS" });

    expect(c).toHaveLength(1);
    expect(c[0].conflitaMotorista).toBe(true);
  });

  it("NÃO acusa homônimo parcial (helper conservador)", async () => {
    // driverNamesMatch é deliberadamente conservador: nomes diferentes não casam.
    await seedComAlocacao({ lh: "LT-OUTRA", motorista: "LEANDRO SANTOS SANTOS" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "LEANDRO FARIA SANTOS" });

    expect(c).toEqual([]);
  });

  it("sem motorista e sem placa → não consulta nada", async () => {
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });
    expect(await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA })).toEqual([]);
    expect(await buscar({ cargoId: alvo, lh: "LT-ALVO", data: DIA, motorista: "  " })).toEqual([]);
  });

  it("data ausente → não consulta (sem data não há como comparar agenda)", async () => {
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });
    expect(await buscar({ cargoId: alvo, lh: "LT-ALVO", data: null, motorista: "CLOVIS" })).toEqual([]);
  });

  it("aceita data como Date (pg devolve DATE como Date UTC-midnight)", async () => {
    await seedComAlocacao({ lh: "LT-OUTRA", motorista: "CLOVIS" });
    const alvo = await seedComAlocacao({ lh: "LT-ALVO" });

    const c = await buscar({ cargoId: alvo, lh: "LT-ALVO", data: new Date(`${DIA}T00:00:00Z`), motorista: "CLOVIS" });

    expect(c).toHaveLength(1);
  });

  it("gate DUPLICATE_ALLOC_WARN=off desliga; qualquer outro valor mantém ligado", () => {
    delete process.env.DUPLICATE_ALLOC_WARN;
    expect(duplicateAllocWarnEnabled()).toBe(true);
    process.env.DUPLICATE_ALLOC_WARN = "off";
    expect(duplicateAllocWarnEnabled()).toBe(false);
    process.env.DUPLICATE_ALLOC_WARN = "OFF";
    expect(duplicateAllocWarnEnabled()).toBe(false);
    process.env.DUPLICATE_ALLOC_WARN = "on";
    expect(duplicateAllocWarnEnabled()).toBe(true);
  });
});

describe("describeConflicts", () => {
  it("monta frase em português do operador, sem jargão", () => {
    const frase = describeConflicts(
      [{ lh: "LT0Q8502CP7S1", data: "2026-08-05", horario: "14:30", conflitaMotorista: true, conflitaCavalo: false }],
      { motorista: "Joao Soares de Jesus" },
    );
    expect(frase).toBe("Joao Soares de Jesus já está na carga LT0Q8502CP7S1 que sai 05/08 às 14:30.");
  });

  it("descreve conflito de veículo", () => {
    const frase = describeConflicts(
      [{ lh: "LT-X", data: "2026-08-05", horario: "09:00", conflitaMotorista: false, conflitaCavalo: true }],
      { cavalo: "GGY0E48" },
    );
    expect(frase).toContain("O veículo GGY0E48 já está na carga LT-X");
  });

  it("resume quando há mais de 3 conflitos", () => {
    const muitos = Array.from({ length: 5 }, (_, i) => ({
      lh: `LT-${i}`, data: "2026-08-05", horario: "09:00", conflitaMotorista: true, conflitaCavalo: false,
    }));
    expect(describeConflicts(muitos, { motorista: "CLOVIS" })).toContain("E mais 2 carga(s).");
  });
});
