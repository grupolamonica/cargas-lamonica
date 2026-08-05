import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, query, resetTestDatabase, seedCargo, seedCliente, seedPublicLead, withPgClient, withPgTransaction } from "../application/operator-admin/test-harness.js";
import { classifyMergeResult, parseArgs, runTwinMergeBackfill } from "./twin-merge-backfill.mjs";
import { createSheetLoadId } from "../application/google-sheets/google-sheet-loads.js";

const source = "shopee";

function fakeSupabaseClient() {
  // routeCatalog/routeTemplate ficam vazios (fallback CARRETA/sem valor, igual ao
  // teste "sem gêmea" de ensure-monitor-sheet-cargo.materialize.test.js). O cliente
  // da planilha (resolveSheetClientId) SEMPRE precisa existir — ele chama
  // `.range(0, 0)` especificamente; distinguimos por isso, senão o setup do
  // backfill lança SheetClientNotConfiguredError antes de qualquer teste rodar.
  const empty = { data: [], error: null };
  const fakeClient = { data: [{ id: "00000000-0000-0000-0000-0000000000c1" }], error: null };
  const api = {
    from: () => api,
    select: () => api,
    eq: () => api,
    order: () => api,
    range: async (from, to) => (from === 0 && to === 0 ? fakeClient : empty),
  };
  return api;
}

async function seedDoador(lh, { alloc_motorista = null, alloc_updated_at = null, status = "OPEN", retired_reason = null, reserved_public_lead_id = null, ...over } = {}) {
  const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status, ...over });
  await query(
    `UPDATE public.cargas
        SET lh_manual = $2, alloc_motorista = $3, alloc_updated_at = $4,
            retired_reason = $5, reserved_public_lead_id = $6
      WHERE id = $1`,
    [id, lh, alloc_motorista, alloc_updated_at, retired_reason, reserved_public_lead_id],
  );
  return id;
}

async function seedSnapshot(rows, { id = 1, snapSource = source } = {}) {
  await query(`INSERT INTO public.sheet_monitor_snapshot (id, source, rows_json) VALUES ($1, $2, $3::jsonb)`, [id, snapSource, JSON.stringify(rows)]);
}

function sheetRow(lh, over = {}) {
  return {
    lh, tipo: null, carregamentoLabel: "10/08/2026 09:00", descargaLabel: "11/08/2026 09:00",
    motoristas: "ANA", cavalo: "AAA1B22", carreta: "CCC3D44", status: "AGUARDANDO CARREGAMENTO",
    data: "2026-08-10", horario: "09:00:00", origem: "A", destino: "B", valor: null, ...over,
  };
}

const commonDeps = () => ({
  withPgClient,
  withPgTransaction,
  supabaseClient: fakeSupabaseClient(),
});

describe("parseArgs", () => {
  it("default: dry, sem limite", () => {
    expect(parseArgs([])).toEqual({ apply: false, limit: Infinity });
  });
  it("--apply e --limit=25", () => {
    expect(parseArgs(["--apply", "--limit=25"])).toEqual({ apply: true, limit: 25 });
  });
  it("--limit inválido cai em Infinity (não trava o script)", () => {
    expect(parseArgs(["--limit=abc"])).toEqual({ apply: false, limit: Infinity });
    expect(parseArgs(["--limit=-5"])).toEqual({ apply: false, limit: Infinity });
  });
});

describe("classifyMergeResult", () => {
  it("sem canônica → MATERIALIZAR_E_MERGEAR", () => {
    expect(classifyMergeResult({ canonicaExiste: false, merge: null })).toBe("MATERIALIZAR_E_MERGEAR");
  });
  it("bloqueio de cancelamento no destino", () => {
    expect(classifyMergeResult({ canonicaExiste: true, merge: { skipped: "cancel_no_destino" } })).toBe("BLOQUEADO_CANCEL_NO_DESTINO");
  });
  it("outros bloqueios (reserva/lead/pacote) → BLOQUEADO genérico", () => {
    expect(classifyMergeResult({ canonicaExiste: true, merge: { skipped: "reserva_de_lead_na_perdedora" } })).toBe("BLOQUEADO");
  });
  it("merge com campos copiados → MERGE_PURO", () => {
    expect(classifyMergeResult({ canonicaExiste: true, merge: { skipped: null, copiedFields: ["alloc_motorista"] } })).toBe("MERGE_PURO");
  });
  it("sem nada a copiar → NADA_A_MIGRAR", () => {
    expect(classifyMergeResult({ canonicaExiste: true, merge: { skipped: "nada_a_migrar", copiedFields: [] } })).toBe("NADA_A_MIGRAR");
  });
});

describe("runTwinMergeBackfill (dry)", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterEach(() => { delete process.env.TWIN_MERGE; });
  afterAll(async () => { await closeTestDatabase(); });

  it("gêmea SEM canônica → MATERIALIZAR_E_MERGEAR, nada escrito", async () => {
    const lh = "LT-BACK-1";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.apply).toBe(false);
    expect(r.totalCandidatos).toBe(1);
    expect(r.relatorio[0].classe).toBe("MATERIALIZAR_E_MERGEAR");
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE sheet_lh = $1`, [lh]);
    expect(count.rows[0].n).toBe(0);
  });

  it("gêmea COM canônica existente → mergeLaunchedTwinAlloc em dry, MERGE_PURO, sem escrever", async () => {
    const lh = "LT-BACK-2";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    const winnerId = createSheetLoadId(lh, source);
    const { id } = await seedCargo({ id: winnerId, sheet_lh: lh, origem: "A", destino: "B", status: "BOOKED" });
    await query(`UPDATE public.cargas SET sheet_source = $2 WHERE id = $1`, [id, source]);
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0]).toMatchObject({ classe: "MERGE_PURO", winnerId, campos: ["alloc_motorista"] });
    const cargo = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].alloc_motorista).toBeNull(); // dry não grava
  });

  it("lápide (aposentada, sem canônica) é doadora legítima e entra no relatório", async () => {
    const lh = "LT-BACK-LAPIDE";
    await seedDoador(lh, { alloc_motorista: "CLOVIS", status: "EXPIRED", retired_reason: "twin_taken" });
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0]).toMatchObject({ lh, lapide: true, classe: "MATERIALIZAR_E_MERGEAR" });
  });

  it("LH fora do snapshot atual → FORA_DO_SNAPSHOT (não tenta materializar)", async () => {
    const lh = "LT-BACK-SEM-SNAP";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0].classe).toBe("FORA_DO_SNAPSHOT");
  });

  it("status de cancelamento no snapshot → SNAPSHOT_CANCELADO (não materializa)", async () => {
    const lh = "LT-BACK-CANCEL";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    await seedSnapshot([sheetRow(lh, { status: "CANCELADO" })]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0].classe).toBe("SNAPSHOT_CANCELADO");
  });

  it("gêmea com lead ativo → BLOQUEADO mesmo em dry (a reserva vale mais que o merge)", async () => {
    const lh = "LT-BACK-LEAD";
    const doadorId = await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    await seedPublicLead({ load_id: doadorId, status: "QUEUED" });
    const winnerId = createSheetLoadId(lh, source);
    const { id } = await seedCargo({ id: winnerId, sheet_lh: lh, origem: "A", destino: "B", status: "BOOKED" });
    await query(`UPDATE public.cargas SET sheet_source = $2 WHERE id = $1`, [id, source]);
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0].classe).toBe("BLOQUEADO");
  });

  it("--limit corta a população e sinaliza truncado", async () => {
    await seedDoador("LT-BACK-L1", { alloc_motorista: "A", data: "2026-08-10" });
    await seedDoador("LT-BACK-L2", { alloc_motorista: "B", data: "2026-08-09" });
    await seedSnapshot([sheetRow("LT-BACK-L1"), sheetRow("LT-BACK-L2")]);

    const r = await runTwinMergeBackfill({ apply: false, limit: 1, deps: commonDeps() });

    expect(r.totalCandidatos).toBe(2);
    expect(r.processados).toBe(1);
    expect(r.truncado).toBe(true);
  });

  it("já mergeada (marcador preenchido) não entra nos candidatos", async () => {
    const lh = "LT-BACK-JA-MERGED";
    const doadorId = await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    await query(`UPDATE public.cargas SET alloc_merged_into_cargo_id = gen_random_uuid() WHERE id = $1`, [doadorId]);
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: false, limit: Infinity, deps: commonDeps() });

    expect(r.totalCandidatos).toBe(0);
  });
});

describe("runTwinMergeBackfill (apply)", () => {
  beforeEach(async () => { await resetTestDatabase(); });
  afterEach(() => { delete process.env.TWIN_MERGE; });
  afterAll(async () => { await closeTestDatabase(); });

  it("materializa a canônica de verdade e migra o alloc quando ainda não existe", async () => {
    // O cliente "da planilha" (resolveSheetClientId, via fakeSupabaseClient) precisa
    // existir DE VERDADE — este é o único teste que faz um INSERT real de canônica,
    // então é o único que bate na FK cargas_cliente_id_fk.
    await seedCliente({ id: "00000000-0000-0000-0000-0000000000c1" });
    const lh = "LT-BACK-APPLY-1";
    const doadorId = await seedDoador(lh, { alloc_motorista: "CLOVIS", alloc_updated_at: new Date("2026-08-01").toISOString() });
    await seedSnapshot([sheetRow(lh)]);

    const r = await runTwinMergeBackfill({ apply: true, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0].classe).toBe("MERGE_PURO");
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT sheet_lh, alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0]).toMatchObject({ sheet_lh: lh, alloc_motorista: "CLOVIS" });
    const doador = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [doadorId]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBe(winnerId);
  });

  it("apply: linha do snapshot SEM data herda a agenda do doador (não cai em ERRO)", async () => {
    // Reproduzido ao rodar em produção: a Shopee publica algumas viagens sem data de
    // carregamento; `cargas.data` é NOT NULL, então o INSERT estourava 23502 e o LH
    // caía na classe ERRO com a decisão do operador presa na lápide
    // (LT0Q8302CP7K1 / CLOVIS BRITO FILHO).
    await seedCliente({ id: "00000000-0000-0000-0000-0000000000c1" });
    const lh = "LT-BACK-SEM-DATA";
    const doadorId = await seedDoador(lh, {
      alloc_motorista: "CLOVIS",
      alloc_updated_at: new Date("2026-08-01").toISOString(),
      data: "2026-08-03",
      horario: "14:00:00",
    });
    await seedSnapshot([sheetRow(lh, { data: null, horario: null, carregamentoLabel: null })]);

    const r = await runTwinMergeBackfill({ apply: true, limit: Infinity, deps: commonDeps() });

    expect(r.relatorio[0].classe).toBe("MERGE_PURO");
    const winnerId = createSheetLoadId(lh, source);
    const cargo = await query(`SELECT data, horario, alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0]).toBeTruthy();
    // pg devolve DATE como Date em UTC-midnight — comparar via ISO, nunca String(Date).
    const dataIso = cargo.rows[0].data instanceof Date
      ? cargo.rows[0].data.toISOString().slice(0, 10)
      : String(cargo.rows[0].data).slice(0, 10);
    expect(dataIso).toBe("2026-08-03");
    expect(cargo.rows[0].alloc_motorista).toBe("CLOVIS");
    const doador = await query(`SELECT alloc_merged_into_cargo_id FROM public.cargas WHERE id = $1`, [doadorId]);
    expect(doador.rows[0].alloc_merged_into_cargo_id).toBe(winnerId);
  });

  it("apply com canônica já existente mergeia de verdade (sem duplicar linha)", async () => {
    const lh = "LT-BACK-APPLY-2";
    await seedDoador(lh, { alloc_motorista: "CLOVIS" });
    const winnerId = createSheetLoadId(lh, source);
    const { id } = await seedCargo({ id: winnerId, sheet_lh: lh, origem: "A", destino: "B", status: "BOOKED" });
    await query(`UPDATE public.cargas SET sheet_source = $2 WHERE id = $1`, [id, source]);
    await seedSnapshot([sheetRow(lh)]);

    await runTwinMergeBackfill({ apply: true, limit: Infinity, deps: commonDeps() });

    const cargo = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [winnerId]);
    expect(cargo.rows[0].alloc_motorista).toBe("CLOVIS");
    const count = await query(`SELECT count(*)::int AS n FROM public.cargas WHERE sheet_lh = $1`, [lh]);
    expect(count.rows[0].n).toBe(1);
  });
});
