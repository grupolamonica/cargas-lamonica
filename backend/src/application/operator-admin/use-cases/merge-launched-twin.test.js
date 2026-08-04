import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `withPgTransaction` vem do HARNESS (pg-mem), não da infraestrutura real: o motor do
// merge recebe o client da transação em curso, então o teste precisa abrir a transação
// no mesmo banco em memória em que as fixtures foram semeadas.
import { resetTestDatabase, query, seedCargo, seedPublicLead, withPgTransaction } from "../test-harness.js";
import { mergeLaunchedTwinAlloc, twinMergeMode } from "./merge-launched-twin.js";
import { resolveMonitorCargoByLh, ensureMonitorSheetCargo } from "./_shared.js";

// Cenário canônico: uma viagem SPX que existe como DUAS cargas — a linha da planilha
// (canônica) e a carga lançada pela Programação, que carrega a decisão do operador.
async function seedPar({
  lh = "LT-PAR-1",
  source = "shopee",
  winner = {},
  loser = {},
} = {}) {
  const { id: winnerId } = await seedCargo({ sheet_lh: lh, sheet_source: source, origem: "A", destino: "B", status: "BOOKED" });
  const { id: loserId } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "RESERVED" });
  const set = async (id, cols) => {
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    await query(
      `UPDATE public.cargas SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
      [id, ...keys.map((k) => cols[k])],
    );
  };
  await set(loserId, { lh_manual: lh, ...loser });
  await set(winnerId, winner);
  return { winnerId, loserId, lh };
}

const alloc = async (id) => (await query(
  `SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_tipo, alloc_pinned,
          alloc_updated_at, alloc_merged_into_cargo_id, alloc_merged_at, lh_manual
     FROM public.cargas WHERE id = $1`, [id],
)).rows[0];

const auditos = async (tipo) => (await query(
  `SELECT resource_id, metadata FROM public.security_audit_logs WHERE event_type = $1 ORDER BY created_at`, [tipo],
)).rows;

describe("twinMergeMode (gate)", () => {
  afterEach(() => { delete process.env.TWIN_MERGE; });

  it("off por padrão, e qualquer valor estranho cai em off", () => {
    expect(twinMergeMode()).toBe("off");
    process.env.TWIN_MERGE = "sim";
    expect(twinMergeMode()).toBe("off");
    process.env.TWIN_MERGE = "DRY";
    expect(twinMergeMode()).toBe("dry");
    process.env.TWIN_MERGE = "on";
    expect(twinMergeMode()).toBe("on");
  });
});

describe("mergeLaunchedTwinAlloc", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.TWIN_MERGE = "on";
  });
  afterEach(() => { delete process.env.TWIN_MERGE; });

  it("gate off → no-op declarado (nem procura gêmea)", async () => {
    process.env.TWIN_MERGE = "off";
    const { winnerId, lh } = await seedPar({ loser: { alloc_motorista: "ANA", alloc_updated_at: new Date().toISOString() } });
    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));
    expect(r).toMatchObject({ merged: false, skipped: "disabled" });
    expect((await alloc(winnerId)).alloc_motorista).toBeNull();
  });

  it("migra a decisão do operador para a canônica e marca a perdedora", async () => {
    const { winnerId, loserId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_cavalo: "AAA1B22", alloc_carreta: "CCC3D44", alloc_tipo: "SPOT", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });

    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r.merged).toBe(true);
    expect(r.copiedFields).toEqual(expect.arrayContaining(["alloc_motorista", "alloc_cavalo", "alloc_carreta", "alloc_tipo"]));
    const w = await alloc(winnerId);
    expect(w).toMatchObject({ alloc_motorista: "ANA", alloc_cavalo: "AAA1B22", alloc_carreta: "CCC3D44" });
    const l = await alloc(loserId);
    expect(l.alloc_merged_into_cargo_id).toBe(winnerId);
    expect(l.alloc_merged_at).not.toBeNull();
    // NUNCA zera os alloc_* nem limpa lh_manual da perdedora (pré-imagem + gate
    // anti-duplo-lançamento).
    expect(l.alloc_motorista).toBe("ANA");
    expect(l.lh_manual).toBe(lh);
  });

  it("auditoria append-only no id da VENCEDORA, com as duas pré-imagens", async () => {
    const { winnerId, loserId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });
    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId, correlationId: "corr-1" }));

    const evs = await auditos("system.cargo.twin_alloc_merged");
    expect(evs).toHaveLength(1);
    // O elo é o `resource_id` (coluna, não sanitizada) + a coluna
    // `alloc_merged_into_cargo_id` da perdedora. UUID em metadata seria redigido pelo
    // sanitizador (32+ chars = segredo inline), então nem tentamos gravar ali.
    expect(evs[0].resource_id).toBe(winnerId);
    expect(evs[0].metadata).toMatchObject({ lh });
    expect(JSON.stringify(evs[0].metadata)).not.toContain("REDACTED");
    expect((await alloc(loserId)).alloc_merged_into_cargo_id).toBe(winnerId);
    expect(evs[0].metadata.beforeWinner).toBeTruthy();
    expect(evs[0].metadata.beforeLoser.motorista).toBe("ANA");
  });

  it("NÃO apaga valor da vencedora com vazio do doador (erasure — modo de falha do #412)", async () => {
    const { winnerId, lh } = await seedPar({
      winner: { alloc_motorista: "BIA", alloc_updated_at: "2026-08-01T09:00:00Z" },
      // Doador mais NOVO, porém com vazio explícito: não pode vencer.
      loser: { alloc_motorista: "", alloc_updated_at: "2026-08-02T09:00:00Z" },
    });

    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r.copiedFields).not.toContain("alloc_motorista");
    expect((await alloc(winnerId)).alloc_motorista).toBe("BIA");
  });

  it("decisão MAIS NOVA da vencedora não é sobrescrita (e por isso é idempotente)", async () => {
    const { winnerId, lh } = await seedPar({
      winner: { alloc_motorista: "BIA", alloc_updated_at: "2026-08-03T09:00:00Z" },
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T09:00:00Z" },
    });

    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect((await alloc(winnerId)).alloc_motorista).toBe("BIA");
  });

  it("conflito real: doador mais novo com nome diferente vence e fica no audit", async () => {
    const { winnerId, lh } = await seedPar({
      winner: { alloc_motorista: "BIA", alloc_updated_at: "2026-08-01T09:00:00Z" },
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-02T09:00:00Z" },
    });

    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect((await alloc(winnerId)).alloc_motorista).toBe("ANA");
    const [ev] = await auditos("system.cargo.twin_alloc_merged");
    expect(ev.metadata.beforeWinner.motorista).toBe("BIA");
    expect(ev.metadata.beforeLoser.motorista).toBe("ANA");
  });

  it("rodar duas vezes não muda nada na segunda (marcador tira o par do universo)", async () => {
    const { winnerId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });
    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));
    const depois1 = await alloc(winnerId);

    const r2 = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r2).toMatchObject({ merged: false, skipped: "sem_gemea" });
    expect(await alloc(winnerId)).toEqual(depois1);
    expect(await auditos("system.cargo.twin_alloc_merged")).toHaveLength(1);
  });

  it("alloc_status de CANCELAMENTO não migra — vai como naoMigrado", async () => {
    const { winnerId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_status: "CANCELADO", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });

    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r.merged).toBe(true);
    expect(r.copiedFields).not.toContain("alloc_status");
    expect(r.naoMigrado.status).toBe("CANCELADO");
    expect((await alloc(winnerId)).alloc_status).toBeNull();
  });

  it("BLOQUEIA o merge inteiro quando o efetivo da vencedora é cancelamento (incidente dos 39)", async () => {
    for (const [campo, valor] of [["alloc_status", "CANCELADO"], ["sheet_status", "CANCELADO"], ["alloc_status", "NO SHOW"]]) {
      await resetTestDatabase();
      const { winnerId, lh } = await seedPar({
        lh: `LT-CANCEL-${campo}-${valor}`.replace(/\s/g, ""),
        winner: { [campo]: valor },
        loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" },
      });

      const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

      expect(r, `${campo}=${valor}`).toMatchObject({ merged: false, skipped: "cancel_no_destino" });
      expect((await alloc(winnerId)).alloc_motorista).toBeNull();
    }
  });

  it("PULA a gêmea com reserva/claim/pacote na perdedora (a reserva vale mais que unificar)", async () => {
    const casos = [
      ["reserved_claim_id", "11111111-1111-1111-1111-111111111111", "reserva_de_claim_na_perdedora"],
      ["reserved_driver_id", "22222222-2222-2222-2222-222222222222", "reserva_de_motorista_na_perdedora"],
      ["booked_driver_id", "33333333-3333-3333-3333-333333333333", "motorista_booked_na_perdedora"],
      ["viagem_id", "44444444-4444-4444-4444-444444444444", "perna_de_pacote_na_perdedora"],
    ];
    for (const [campo, valor, motivo] of casos) {
      await resetTestDatabase();
      const { winnerId, lh } = await seedPar({
        lh: `LT-${campo}`,
        loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z", [campo]: valor },
      });

      const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

      expect(r, campo).toMatchObject({ merged: false, skipped: motivo });
      expect((await alloc(winnerId)).alloc_motorista).toBeNull();
    }
  });

  it("PULA quando a perdedora tem lead ativo (não cancela nem re-aponta candidatura)", async () => {
    const { winnerId, loserId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });
    await seedPublicLead({ load_id: loserId, status: "QUEUED" });

    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r).toMatchObject({ merged: false, skipped: "lead_ativo_na_perdedora" });
    const leads = await query(`SELECT status FROM public.load_public_leads WHERE load_id = $1`, [loserId]);
    expect(leads.rows[0].status).toBe("QUEUED"); // intacto
  });

  it("dry: decide e devolve os campos, sem escrever nada", async () => {
    process.env.TWIN_MERGE = "dry";
    const { winnerId, loserId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });

    const r = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));

    expect(r).toMatchObject({ merged: false, mode: "dry" });
    expect(r.copiedFields).toContain("alloc_motorista");
    expect((await alloc(winnerId)).alloc_motorista).toBeNull();
    expect((await alloc(loserId)).alloc_merged_into_cargo_id).toBeNull();
    expect(await auditos("system.cargo.twin_alloc_merged")).toHaveLength(0);
  });

  it('"fixo" migra só quando a vencedora não está fixa', async () => {
    const { winnerId, lh } = await seedPar({
      winner: { alloc_pinned: true },
      loser: { alloc_motorista: "ANA", alloc_pinned: true, alloc_updated_at: "2026-08-01T10:00:00Z" },
    });
    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh, winnerId }));
    expect((await alloc(winnerId)).alloc_pinned).toBe(true);

    await resetTestDatabase();
    const par2 = await seedPar({ lh: "LT-PIN-2", loser: { alloc_pinned: true, alloc_updated_at: "2026-08-01T10:00:00Z" } });
    await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh: par2.lh, winnerId: par2.winnerId }));
    expect((await alloc(par2.winnerId)).alloc_pinned).toBe(true);
  });
});

describe("resolveMonitorCargoByLh — resolução canônica (gate on)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.TWIN_MERGE = "on";
  });
  afterEach(() => { delete process.env.TWIN_MERGE; });

  it("a CANÔNICA da planilha vence a carga lançada", async () => {
    const { winnerId, lh } = await seedPar({ loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" } });
    const r = await withPgTransaction((c) => resolveMonitorCargoByLh(c, lh, { forUpdate: false }));
    expect(r.id).toBe(winnerId);
  });

  it("NUNCA resolve para a lápide quando existe canônica (defeito da LT1Q8302D4IK2)", async () => {
    const { winnerId, loserId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-03T10:00:00Z", retired_reason: "twin_taken", status: "EXPIRED" },
    });
    const r = await withPgTransaction((c) => resolveMonitorCargoByLh(c, lh, { forUpdate: false }));
    expect(r.id).toBe(winnerId);
    expect(r.id).not.toBe(loserId);
  });

  it("sem canônica, resolve para a lançada VIVA (e não filtra por status)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "EXPIRED" });
    await query(`UPDATE public.cargas SET lh_manual = $2 WHERE id = $1`, [id, "LT-SO-SISTEMA"]);
    const r = await withPgTransaction((c) => resolveMonitorCargoByLh(c, "LT-SO-SISTEMA", { forUpdate: false }));
    expect(r.id).toBe(id); // viagem passada segue editável
  });

  it("casa a canônica de OUTRA FONTE pela coluna sheet_lh (o braço por id era morto p/ Nestlé)", async () => {
    const { id } = await seedCargo({ sheet_lh: "B101-NESTLE", sheet_source: "nestle", origem: "A", destino: "B", status: "BOOKED" });
    const r = await withPgTransaction((c) => resolveMonitorCargoByLh(c, "B101-NESTLE", { forUpdate: false }));
    expect(r.id).toBe(id);
  });

  it("LH em DUAS fontes → conflito explícito, não escolhe por heurística", async () => {
    await seedCargo({ sheet_lh: "LT-DUP", sheet_source: "shopee", origem: "A", destino: "B", status: "BOOKED" });
    await seedCargo({ sheet_lh: "LT-DUP", sheet_source: "nestle", origem: "A", destino: "B", status: "BOOKED" });
    await expect(
      withPgTransaction((c) => resolveMonitorCargoByLh(c, "LT-DUP", { forUpdate: false })),
    ).rejects.toThrow(/mais de uma planilha/i);
  });

  it("gate off preserva o comportamento de hoje (lançada com alloc vence)", async () => {
    process.env.TWIN_MERGE = "off";
    const { loserId, lh } = await seedPar({ loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" } });
    const r = await withPgTransaction((c) => resolveMonitorCargoByLh(c, lh, { forUpdate: false }));
    expect(r.id).toBe(loserId);
  });
});

describe("ensureMonitorSheetCargo — merge LAZY na mesma transação", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.TWIN_MERGE = "on";
  });
  afterEach(() => { delete process.env.TWIN_MERGE; });

  // Prova de que a semântica PARCIAL da escrita sobreviveu: quem resolve recebe a
  // canônica JÁ com os alloc_* herdados, então salvar só o status não apaga o motorista.
  it("devolve a canônica já com a alocação herdada da gêmea", async () => {
    const { winnerId, lh } = await seedPar({
      loser: { alloc_motorista: "ANA", alloc_carreta: "CCC3D44", alloc_updated_at: "2026-08-01T10:00:00Z" },
    });

    const row = await withPgTransaction((c) =>
      ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh, alloc_motorista, alloc_carreta", forUpdate: false }),
    );

    expect(row.id).toBe(winnerId);
    expect(row.alloc_motorista).toBe("ANA");
    expect(row.alloc_carreta).toBe("CCC3D44");
  });

  it("gate off → devolve a linha de hoje, sem merge", async () => {
    process.env.TWIN_MERGE = "off";
    const { loserId, lh } = await seedPar({ loser: { alloc_motorista: "ANA", alloc_updated_at: "2026-08-01T10:00:00Z" } });
    const row = await withPgTransaction((c) =>
      ensureMonitorSheetCargo(c, lh, { columns: "id, sheet_lh, alloc_motorista", forUpdate: false }),
    );
    expect(row.id).toBe(loserId);
  });
});
