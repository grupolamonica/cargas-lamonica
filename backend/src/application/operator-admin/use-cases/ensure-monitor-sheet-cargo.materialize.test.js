import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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

// A LÁPIDE (gêmea aposentada/mergeada) deixou de ser aceita como alvo de escrita.
// Antes, `existing` a devolvia, `withLazyTwinMerge` fazia no-op (só a canônica é
// destino de merge) e a materialização nunca rodava: a escrita ia 200 OK numa linha
// morta e o operador achava que tinha salvo. Medido em produção (05/08).
describe("ensureMonitorSheetCargo — lápide não é alvo de escrita", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterEach(() => { delete process.env.TWIN_MERGE; });
  afterAll(async () => { await closeTestDatabase(); });

  async function seedLapide(lh, { alloc_motorista = "SILON", retired_reason = "twin_taken", alloc_merged_into_cargo_id = null } = {}) {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "EXPIRED" });
    await query(
      `UPDATE public.cargas
          SET lh_manual = $2, alloc_motorista = $3, retired_reason = $4, alloc_merged_into_cargo_id = $5
        WHERE id = $1`,
      [id, lh, alloc_motorista, retired_reason, alloc_merged_into_cargo_id],
    );
    return id;
  }

  it("gate ON: materializa a canônica e HERDA a decisão da lápide (não grava nela)", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-LAPIDE-1";
    const lapideId = await seedLapide(lh);
    await seedSnapshot({ source: "shopee", rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00", motoristas: "ANA" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh, alloc_motorista" }));

    // Devolveu a CANÔNICA, não a lápide.
    expect(row.id).not.toBe(lapideId);
    expect(row.sheet_lh).toBe(lh);
    // E a decisão do operador que estava presa na lápide veio junto.
    expect(row.alloc_motorista).toBe("SILON");
    const lapide = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [lapideId]);
    expect(lapide.rows[0].alloc_merged_into_cargo_id).toBe(row.id);
  });

  it("gate ON: lápide JÁ mergeada também não é alvo (materializa/resolve a canônica)", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-LAPIDE-MERGED";
    const lapideId = await seedLapide(lh, { retired_reason: null, alloc_merged_into_cargo_id: createSheetLoadId(lh, "shopee") });
    await seedSnapshot({ source: "shopee", rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh" }));

    expect(row.id).not.toBe(lapideId);
    expect(row.sheet_lh).toBe(lh);
  });

  it("gate ON: lápide SEM linha na planilha → null (404 honesto, não escrita fantasma)", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-LAPIDE-SEM-SNAP";
    await seedLapide(lh);

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh" }));

    expect(row).toBeNull();
  });

  it("gate ON: linha da planilha CANCELADA → null (não materializa sobre cancelamento)", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-LAPIDE-CANCEL";
    await seedLapide(lh);
    await seedSnapshot({ source: "shopee", rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00", status: "CANCELADO" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh" }));

    expect(row).toBeNull();
  });

  it("gate OFF: devolve a lápide (comportamento anterior preservado byte a byte)", async () => {
    delete process.env.TWIN_MERGE;
    const lh = "LT-LAPIDE-OFF";
    const lapideId = await seedLapide(lh);
    await seedSnapshot({ source: "shopee", rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh" }));

    expect(row.id).toBe(lapideId);
  });

  it("gate ON: gêmea VIVA (não aposentada) continua sendo devolvida — regressão", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-VIVA";
    const vivaId = await seedLapide(lh, { retired_reason: null });
    await query(`UPDATE public.cargas SET status = 'RESERVED' WHERE id = $1`, [vivaId]);
    await seedSnapshot({ source: "shopee", rows: [{ lh, origem: "A", destino: "B", data: "2026-08-10", horario: "09:00:00" }] });

    const row = await withPgTransaction((c) => ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh" }));

    expect(row.id).toBe(vivaId);
    expect(row.sheet_lh).toBeNull();
  });
});
