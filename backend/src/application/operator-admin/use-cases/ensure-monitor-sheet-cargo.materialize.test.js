import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, query, resetTestDatabase, seedCargo, withPgTransaction } from "../test-harness.js";
import { ensureMonitorSheetCargo } from "./_shared.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

// `ensureMonitorSheetCargo` só chega a MATERIALIZAR quando `resolveMonitorCargoByLh`
// (a checagem `existing`) devolve null — e essa checagem casa `lh_manual = $1 AND
// sheet_lh IS NULL` incondicionalmente. Ou seja: o ramo de materialização só é
// alcançado quando NÃO existe absolutamente nenhuma carga para o LH (nem planilha,
// nem lançada) — o cenário original desta função: viagem que entrou na planilha já
// atribuída, sem o operador ter lançado nada na Programação. Por isso estes testes
// NÃO seedam uma gêmea lançada antes de materializar (isso testaria "existing" a
// devolver a lançada, não a materialização).
async function seedSnapshot({ id = 1, source = null, rows }) {
  await query(
    `INSERT INTO public.sheet_monitor_snapshot (id, source, rows_json) VALUES ($1, $2, $3::jsonb)`,
    [id, source, JSON.stringify(rows)],
  );
}

describe("ensureMonitorSheetCargo — materialização a partir do snapshot", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterAll(async () => { await closeTestDatabase(); });

  it("grava sheet_source da fonte onde o LH foi encontrado (não fica órfã do sync)", async () => {
    await seedSnapshot({ id: 1, source: "shopee", rows: [{ lh: "LT-SHOPEE-1", origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" }] });
    await seedSnapshot({ id: 2, source: "nestle", rows: [{ lh: "B101-NESTLE-1", origem: "C", destino: "D", data: "2026-08-10", horario: "09:00:00" }] });

    const shopee = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "LT-SHOPEE-1", {}));
    const nestle = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "B101-NESTLE-1", {}));

    expect(shopee).not.toBeNull();
    expect(nestle).not.toBeNull(); // antes desta correção, a releitura por id sem
    // fonte devolvia null pra qualquer fonte não-default — regressão coberta aqui.
    const rows = await query(`SELECT sheet_lh, sheet_source FROM public.cargas WHERE sheet_lh IN ('LT-SHOPEE-1', 'B101-NESTLE-1') ORDER BY sheet_lh`);
    expect(rows.rows).toEqual([
      { sheet_lh: "B101-NESTLE-1", sheet_source: "nestle" },
      { sheet_lh: "LT-SHOPEE-1", sheet_source: "shopee" },
    ]);
    // Ids diferentes: mesmo LH em fontes diferentes não colidiria (namespace por fonte).
    expect(shopee.id).not.toBe(nestle.id);
  });

  it("busca em TODAS as fontes do snapshot, não só a primeira (id=1)", async () => {
    await seedSnapshot({ id: 1, source: "shopee", rows: [{ lh: "LT-OUTRO", origem: "X", destino: "Y" }] });
    await seedSnapshot({ id: 2, source: "nestle", rows: [{ lh: "B101-ACHAR", origem: "C", destino: "D", data: "2026-08-10", horario: "09:00:00" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "B101-ACHAR", {}));

    expect(row).not.toBeNull();
    const cargo = await query(`SELECT sheet_source FROM public.cargas WHERE id = $1`, [row.id]);
    expect(cargo.rows[0].sheet_source).toBe("nestle");
  });

  it("NÃO materializa quando o status do snapshot é cancelamento (evita armar o sweep sem migrar nada)", async () => {
    for (const status of ["CANCELADO", "NO SHOW", "DEVOLVIDO"]) {
      await resetTestDatabase();
      const lh = `LT-CANCEL-${status}`.replace(/\s/g, "");
      await seedSnapshot({ rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00", status }] });

      const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, {}));

      expect(row, status).toBeNull();
    }
  });

  it("status BOOKED quando o snapshot já traz motorista; OPEN quando vazio", async () => {
    await seedSnapshot({
      rows: [
        { lh: "LT-COM-MOTORISTA", origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00", motoristas: "ANA" },
        { lh: "LT-SEM-MOTORISTA", origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" },
      ],
    });

    const comMotorista = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "LT-COM-MOTORISTA", {}));
    const semMotorista = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "LT-SEM-MOTORISTA", {}));

    const rows = await query(`SELECT sheet_lh, status FROM public.cargas WHERE id = $1 OR id = $2`, [comMotorista.id, semMotorista.id]);
    const byLh = Object.fromEntries(rows.rows.map((r) => [r.sheet_lh, r.status]));
    expect(byLh["LT-COM-MOTORISTA"]).toBe("BOOKED");
    expect(byLh["LT-SEM-MOTORISTA"]).toBe("OPEN");
  });

  it("pré-check por (fonte, LH) evita 23505: corrida concorrente já materializou → relê e segue", async () => {
    await seedSnapshot({ id: 1, source: "shopee", rows: [{ lh: "LT-RACE-1", origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" }] });
    // Simula uma materialização concorrente já ter acontecido, com o MESMO id
    // determinístico que ensureMonitorSheetCargo calcularia.
    const raceId = createSheetLoadId("LT-RACE-1", "shopee");
    await seedCargo({ id: raceId, sheet_lh: "LT-RACE-1", origem: "A", destino: "B", status: "OPEN" });
    await query(`UPDATE public.cargas SET sheet_source = 'shopee' WHERE id = $1`, [raceId]);

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "LT-RACE-1", { columns: "id, sheet_lh" }));

    expect(row.id).toBe(raceId); // releu a existente, não tentou inserir de novo
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE sheet_lh = 'LT-RACE-1'`);
    expect(count.rows[0].n).toBe(1); // nenhuma linha duplicada
  });

  it("com uma gêmea LANÇADA já existindo, devolve a gêmea (materialização não roda) — documenta o limite atual", async () => {
    const { id: gemeaId } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "RESERVED" });
    await query(`UPDATE public.cargas SET lh_manual = 'LT-COM-GEMEA' WHERE id = $1`, [gemeaId]);
    await seedSnapshot({ rows: [{ lh: "LT-COM-GEMEA", origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00", motoristas: "ANA" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, "LT-COM-GEMEA", { columns: "id, sheet_lh" }));

    expect(row.id).toBe(gemeaId);
    expect(row.sheet_lh).toBeNull();
    // Nenhuma linha nova (canônica) foi criada.
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas`);
    expect(count.rows[0].n).toBe(1);
  });
});
