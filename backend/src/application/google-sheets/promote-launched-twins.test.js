import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, query, resetTestDatabase, seedCargo, seedPublicLead, withPgTransaction } from "../operator-admin/test-harness.js";
import { promoteLaunchedTwinsBeforeRetirement } from "./promote-launched-twins.js";
import { createSheetLoadId } from "./google-sheet-loads.js";

const source = "shopee";
const EMPTY_MAP = new Map();
const EMPTY_SET = new Set();

function baseArgs(overrides = {}) {
  return {
    source,
    takenSheetLhs: [],
    existingLoadsBySheetLh: new Map(),
    currentSheetKeys: new Set(),
    allSheetRowsByLh: new Map(),
    routeCatalogDefaultsByKey: EMPTY_MAP,
    routeTemplateDefaultsByKey: EMPTY_MAP,
    knownCatalogTrechos: EMPTY_SET,
    fallbackSheetClientId: null,
    syncedAt: new Date(0).toISOString(),
    // O módulo importa `withPgTransaction` da infra REAL por padrão — aqui
    // substituímos pela versão do harness (pg-mem) via injeção de dependência.
    deps: { withPgTransaction },
    ...overrides,
  };
}

function sheetRow(lh, over = {}) {
  return {
    lh,
    tipo: null,
    carregamentoLabel: "10/08/2026 09:00",
    descargaLabel: "11/08/2026 09:00",
    motoristas: "ANA",
    cavalo: "AAA1B22",
    carreta: "CCC3D44",
    status: "AGUARDANDO CARREGAMENTO",
    data: "2026-08-10",
    horario: "09:00:00",
    origem: "A",
    destino: "B",
    valor: null,
    ...over,
  };
}

// `seedCargo` NÃO insere alloc_*/reserved_*/lh_manual (não estão no INSERT do
// harness) — sempre precisa de um UPDATE cru depois, igual a merge-launched-twin.test.js.
async function seedDoador(lh, { alloc_motorista = null, alloc_updated_at = null, reserved_public_lead_id = null, ...seedOverrides } = {}) {
  const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", ...seedOverrides });
  await query(
    `UPDATE public.cargas
        SET lh_manual = $2, alloc_motorista = $3, alloc_updated_at = $4, reserved_public_lead_id = $5
      WHERE id = $1`,
    [id, lh, alloc_motorista, alloc_updated_at, reserved_public_lead_id],
  );
  return id;
}

describe("promoteLaunchedTwinsBeforeRetirement", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterEach(() => { delete process.env.TWIN_MERGE; });
  afterAll(async () => { await closeTestDatabase(); });

  it("gate off → no-op declarado, nenhuma transação aberta", async () => {
    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: ["LT-A"] }),
    );
    expect(r).toMatchObject({ mode: "off", candidatos: 0, materializados: 0 });
  });

  it("on: materializa a canônica e migra a decisão do operador", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-PROMOTE-1";
    const doadorId = await seedDoador(lh, { alloc_motorista: "CLOVIS", alloc_updated_at: new Date("2026-08-01").toISOString() });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({
        takenSheetLhs: [lh],
        allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]),
      }),
    );

    expect(r).toMatchObject({ mode: "on", candidatos: 1, materializados: 1, mergeados: 1, bloqueados: 0 });
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT sheet_lh, sheet_source, alloc_motorista, status FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0]).toMatchObject({ sheet_lh: lh, sheet_source: source, alloc_motorista: "CLOVIS" });
    const doador = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [doadorId]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBe(winnerId);
  });

  it("on: LÁPIDE órfã (aposentada, sem canônica) é doadora e volta a ser recuperada pelo ciclo", async () => {
    // Antes o doador exigia retired_reason IS NULL, o que tornava DEFINITIVO qualquer
    // pulo desta passada: o CTE de aposentadoria roda em bloco separado e incondicional,
    // então depois de aposentada este LH devolvia "sem_gemea" para sempre e a canônica
    // nunca mais nascia (porta de mão única — o passivo medido em produção).
    process.env.TWIN_MERGE = "on";
    const lh = "LT-PROMOTE-LAPIDE";
    const doadorId = await seedDoador(lh, {
      alloc_motorista: "SILON",
      alloc_updated_at: new Date("2026-08-01").toISOString(),
      status: "EXPIRED",
    });
    await query(`UPDATE public.cargas SET retired_reason = 'twin_taken' WHERE id = $1`, [doadorId]);

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    expect(r).toMatchObject({ mode: "on", candidatos: 1, materializados: 1, mergeados: 1, bloqueados: 0 });
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(
      `SELECT sheet_lh, sheet_source, alloc_motorista FROM public.cargas WHERE id = $1`,
      [winnerId],
    );
    expect(cargo.rows[0]).toMatchObject({ sheet_lh: lh, sheet_source: source, alloc_motorista: "SILON" });
    // A lápide continua lápide (nunca é alvo) e agora aponta para a canônica.
    const doador = await query(
      `SELECT alloc_merged_into_cargo_id, retired_reason, alloc_motorista FROM public.cargas WHERE id = $1`,
      [doadorId],
    );
    expect(doador.rows[0]).toMatchObject({ alloc_merged_into_cargo_id: winnerId, retired_reason: "twin_taken" });
    expect(doador.rows[0].alloc_motorista).toBe("SILON"); // alloc_* da perdedora nunca é zerado
  });

  it("on: com gêmea VIVA e lápide no mesmo LH, a VIVA é preferida como doadora", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-PROMOTE-DUAS";
    const lapideId = await seedDoador(lh, {
      alloc_motorista: "ANTIGO",
      alloc_updated_at: new Date("2026-07-01").toISOString(),
      status: "EXPIRED",
    });
    await query(`UPDATE public.cargas SET retired_reason = 'twin_taken' WHERE id = $1`, [lapideId]);
    const vivaId = await seedDoador(lh, {
      alloc_motorista: "ATUAL",
      alloc_updated_at: new Date("2026-08-02").toISOString(),
    });

    await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].alloc_motorista).toBe("ATUAL");
    const viva = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [vivaId]);
    expect(viva.rows[0].alloc_merged_into_cargo_id).toBe(winnerId);
  });

  it("on: linha da planilha SEM data herda a agenda da gêmea (não estoura 23502)", async () => {
    // Reproduzido em produção: a Shopee publica algumas viagens sem data de
    // carregamento. `buildAllocatedSheetLoadPayload` devolve data/horario NULL e
    // `cargas.data` é NOT NULL → o INSERT estourava 23502, o catch por LH engolia e o
    // CTE aposentava a gêmea de qualquer forma (LT0Q8302CP7K1, CLOVIS BRITO FILHO).
    process.env.TWIN_MERGE = "on";
    const lh = "LT-PROMOTE-SEM-DATA";
    const doadorId = await seedDoador(lh, {
      alloc_motorista: "CLOVIS",
      alloc_updated_at: new Date("2026-08-01").toISOString(),
      data: "2026-08-03",
      horario: "14:00:00",
    });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({
        takenSheetLhs: [lh],
        allSheetRowsByLh: new Map([[lh, sheetRow(lh, { data: null, horario: null, carregamentoLabel: null })]]),
      }),
    );

    expect(r).toMatchObject({ mode: "on", materializados: 1, mergeados: 1, ignoradosSemAgenda: 0 });
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(
      `SELECT data, horario, alloc_motorista FROM public.cargas WHERE id = $1`,
      [winnerId],
    );
    expect(cargo.rows[0]).toBeTruthy();
    // Agenda herdada da gêmea — a única data existente para essa viagem.
    // pg devolve DATE como Date em UTC-midnight: comparar via ISO (String(Date)
    // renderiza no fuso local e daria off-by-one em BRT).
    const dataIso = cargo.rows[0].data instanceof Date
      ? cargo.rows[0].data.toISOString().slice(0, 10)
      : String(cargo.rows[0].data).slice(0, 10);
    expect(dataIso).toBe("2026-08-03");
    expect(String(cargo.rows[0].horario)).toContain("14:00");
    expect(cargo.rows[0].alloc_motorista).toBe("CLOVIS");
    const doador = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [doadorId]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBe(winnerId);
  });

  it("dry SEM canônica existente: só CONTA (materializaria), não insere nada", async () => {
    process.env.TWIN_MERGE = "dry";
    const lh = "LT-PROMOTE-DRY";
    await seedDoador(lh, { alloc_motorista: "CLOVIS", alloc_updated_at: new Date("2026-08-01").toISOString() });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    // Sem canônica pré-existente, dry não tenta prever o merge (evitaria escrever
    // pra depois descartar) — só sinaliza "materializaria".
    expect(r).toMatchObject({ mode: "dry", candidatos: 1, materializados: 1, mergeados: 0 });
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].n).toBe(0); // NADA foi inserido de verdade
    const doador = await query(`SELECT alloc_merged_into_cargo_id, alloc_motorista FROM public.cargas WHERE lh_manual = $1`, [lh]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBeNull(); // intocada
    expect(doador.rows[0].alloc_motorista).toBe("CLOVIS"); // intacta
  });

  it("dry COM canônica já existente: mergeLaunchedTwinAlloc só lê — resultado exato, sem escrever", async () => {
    process.env.TWIN_MERGE = "dry";
    const lh = "LT-PROMOTE-DRY-EXISTENTE";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    const winnerId = createSheetLoadId(lh, source);
    const { id } = await seedCargo({ id: winnerId, sheet_lh: lh, origem: "A", destino: "B", status: "BOOKED" });
    await query(`UPDATE public.cargas SET sheet_source = $2 WHERE id = $1`, [id, source]);

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    expect(r).toMatchObject({ mode: "dry", candidatos: 1, materializados: 1, mergeados: 1 });
    const cargo = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].alloc_motorista).toBeNull(); // dry NÃO escreveu de verdade
    const doador = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE lh_manual = $1`, [lh]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBeNull(); // marcador não foi gravado
  });

  it("sem gêmea (LH tomado mas nenhuma carga lançada) → não materializa nada", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-SEM-GEMEA";

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    expect(r).toMatchObject({ candidatos: 1, materializados: 0, mergeados: 0 });
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas`);
    expect(count.rows[0].n).toBe(0);
  });

  it("status de cancelamento no snapshot → ignora (não arma o sweep sem migrar nada)", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-CANCEL-PROMO";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh, { status: "CANCELADO" })]]) }),
    );

    expect(r).toMatchObject({ materializados: 0, ignoradosCancelamento: 1 });
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE sheet_lh = $1`, [lh]);
    expect(count.rows[0].n).toBe(0);
  });

  it("bloqueio do merge (lead ativo na perdedora) ainda materializa a célula, mas não migra o alloc", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-BLOQUEIO";
    const doadorId = await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    await seedPublicLead({ load_id: doadorId, status: "QUEUED" });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    expect(r).toMatchObject({ materializados: 1, mergeados: 0, bloqueados: 1 });
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT sheet_motorista, alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].sheet_motorista).toBe("ANA"); // veio da planilha (row), não do merge
    expect(cargo.rows[0].alloc_motorista).toBeNull(); // merge bloqueado, não migrou
  });

  it("corrida concorrente: canônica já existe → usa o id existente, não duplica", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-RACE-PROMO";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    const raceId = createSheetLoadId(lh, source);
    const { id } = await seedCargo({ id: raceId, sheet_lh: lh, origem: "A", destino: "B", status: "BOOKED" });
    await query(`UPDATE public.cargas SET sheet_source = $2 WHERE id = $1`, [id, source]);

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]) }),
    );

    expect(r.materializados).toBe(1);
    expect(r.mergeados).toBe(1);
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE sheet_lh = $1`, [lh]);
    expect(count.rows[0].n).toBe(1); // nenhuma linha duplicada
  });

  it("adiciona o LH promovido a currentSheetKeys só no modo on (dry não persiste, não deve marcar)", async () => {
    const lh = "LT-KEYS";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });

    process.env.TWIN_MERGE = "on";
    const keysOn = new Set();
    await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]), currentSheetKeys: keysOn }),
    );
    expect(keysOn.has(lh)).toBe(true);

    await resetTestDatabase();
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    process.env.TWIN_MERGE = "dry";
    const keysDry = new Set();
    await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({ takenSheetLhs: [lh], allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]), currentSheetKeys: keysDry }),
    );
    expect(keysDry.has(lh)).toBe(false);
  });

  it("LH já com canônica pré-existente (existingLoadsBySheetLh) não entra nos candidatos", async () => {
    process.env.TWIN_MERGE = "on";
    const lh = "LT-JA-EXISTE";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });

    const r = await promoteLaunchedTwinsBeforeRetirement(
      baseArgs({
        takenSheetLhs: [lh],
        existingLoadsBySheetLh: new Map([[lh, { sheet_lh: lh }]]),
        allSheetRowsByLh: new Map([[lh, sheetRow(lh)]]),
      }),
    );

    expect(r.candidatos).toBe(0);
    expect(r.materializados).toBe(0);
  });
});
