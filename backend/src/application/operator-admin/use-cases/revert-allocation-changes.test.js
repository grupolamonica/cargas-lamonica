import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));
vi.mock("../../google-sheets/sheet-writeback.js", () => ({ writeAllocationsToSheet: vi.fn(async () => {}) }));

const { updateMonitorAllocation } = await import("./update-monitor-allocation.js");
const { descendQueueCascade } = await import("./descend-queue-cascade.js");
const { listOperatorAllocationChanges } = await import("./list-operator-allocation-changes.js");
const { revertAllocationChanges } = await import("./revert-allocation-changes.js");
const { mergeLaunchedTwinAlloc } = await import("./merge-launched-twin.js");

const LH = "LT-REVERT-1";

async function seedSheetCargo(lh = LH, overrides = {}) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN", ...overrides });
  return id;
}

async function getAlloc(id) {
  const { rows } = await query(
    `SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("revert-allocation-changes (list + revert)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("lista a última mudança de alocação do operador com antes → depois", async () => {
    const id = await seedSheetCargo();
    const op = await seedUser({ email: "op-revert-list@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: op.id,
      payload: { motorista: "JOAO", cavalo: "ABC1D23", carreta: "DEF4G56", status: "DESCARREGADO" },
      correlationId: "c1",
    });

    const res = await listOperatorAllocationChanges({ operatorId: op.id, query: {}, correlationId: "c-list" });
    expect(res.statusCode).toBe(200);
    expect(res.payload.items).toHaveLength(1);
    const ev = res.payload.items[0];
    expect(ev.eventType).toBe("operator.cargo.allocation_updated");
    expect(ev.revertible).toBe(true);
    expect(ev.cargos).toHaveLength(1);
    expect(ev.cargos[0].lh).toBe(LH);
    expect(ev.cargos[0].before.motorista ?? "").toBe(""); // não havia override antes
    expect(ev.cargos[0].after.motorista).toBe("JOAO");
    expect(ev.cargos[0].currentMatchesAfter).toBe(true);
    // não lista mudanças de OUTRO operador
    const other = await seedUser({ email: "outro@teste.local" });
    const res2 = await listOperatorAllocationChanges({ operatorId: other.id, query: {}, correlationId: "c-list2" });
    expect(res2.payload.items).toHaveLength(0);

    void id;
  });

  it("reverte allocation_updated: restaura alloc_* ao estado anterior + grava evento", async () => {
    const id = await seedSheetCargo();
    const op = await seedUser({ email: "op-revert-do@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: op.id,
      payload: { motorista: "JOAO", cavalo: "ABC1D23", carreta: "DEF4G56", status: "DESCARREGADO" },
      correlationId: "c1",
    });
    let row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("JOAO");

    const list = await listOperatorAllocationChanges({ operatorId: op.id, query: {} });
    const auditLogId = list.payload.items[0].auditLogId;

    const res = await revertAllocationChanges({
      operatorId: op.id,
      items: [{ auditLogId, lh: LH }],
      correlationId: "c-revert",
    });
    expect(res.payload.revertedCount).toBe(1);
    expect(res.payload.skippedCount).toBe(0);

    // Antes não havia override → volta a NULL (cai pra planilha) e status limpo.
    row = await getAlloc(id);
    expect(row.alloc_motorista).toBeNull();
    expect(row.alloc_cavalo).toBeNull();
    expect(row.alloc_carreta).toBeNull();
    expect(row.alloc_status).toBeNull();

    // Evento de reversão gravado.
    const ev = await query(
      `SELECT event_type, actor_user_id FROM public.security_audit_logs WHERE event_type = 'operator.cargo.allocation_reverted'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].actor_user_id).toBe(op.id);
  });

  it("guarda: se a carga foi alterada depois, o revert PULA (não sobrescreve)", async () => {
    const id = await seedSheetCargo();
    const op = await seedUser({ email: "op-revert-guard@teste.local" });

    // 1ª mudança (a que vamos tentar reverter).
    await updateMonitorAllocation({ lh: LH, operatorId: op.id, payload: { motorista: "JOAO" }, correlationId: "c1" });
    const list = await listOperatorAllocationChanges({ operatorId: op.id, query: {} });
    const firstAuditId = list.payload.items.find((i) => i.cargos[0]?.after.motorista === "JOAO").auditLogId;

    // 2ª mudança: alguém mexeu depois.
    await updateMonitorAllocation({ lh: LH, operatorId: op.id, payload: { motorista: "PEDRO" }, correlationId: "c2" });

    const res = await revertAllocationChanges({
      operatorId: op.id,
      items: [{ auditLogId: firstAuditId, lh: LH }],
      correlationId: "c-revert",
    });
    expect(res.payload.revertedCount).toBe(0);
    expect(res.payload.skippedCount).toBe(1);
    expect(res.payload.skipped[0].reason).toMatch(/alterada depois/i);

    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("PEDRO"); // preservado (não sobrescrito)
  });

  it("escopo: não reverte mudança de OUTRO operador", async () => {
    await seedSheetCargo();
    const op = await seedUser({ email: "op-owner@teste.local" });
    const intruder = await seedUser({ email: "op-intruder@teste.local" });

    await updateMonitorAllocation({ lh: LH, operatorId: op.id, payload: { motorista: "JOAO" }, correlationId: "c1" });
    const list = await listOperatorAllocationChanges({ operatorId: op.id, query: {} });
    const auditLogId = list.payload.items[0].auditLogId;

    const res = await revertAllocationChanges({
      operatorId: intruder.id,
      items: [{ auditLogId, lh: LH }],
      correlationId: "c-revert",
    });
    expect(res.payload.revertedCount).toBe(0);
    expect(res.payload.skipped[0].reason).toMatch(/próprias/i);
  });

  it("reverte uma descida de fila (cascata): restaura os motoristas de cada carga movida", async () => {
    // Fila top→base: LT-1(10h,M1) · LT-2(09h,M2) · LT-3(08h,M3), mesma rota.
    const id1 = await seedSheetCargo("LT-1", { horario: "10:00:00", origem: "S / BA", destino: "F / BA" });
    const id2 = await seedSheetCargo("LT-2", { horario: "09:00:00", origem: "S / BA", destino: "F / BA" });
    const id3 = await seedSheetCargo("LT-3", { horario: "08:00:00", origem: "S / BA", destino: "F / BA" });
    await query(`UPDATE public.cargas SET sheet_motorista = 'M1' WHERE id = $1`, [id1]);
    await query(`UPDATE public.cargas SET sheet_motorista = 'M2' WHERE id = $1`, [id2]);
    await query(`UPDATE public.cargas SET sheet_motorista = 'M3' WHERE id = $1`, [id3]);
    const op = await seedUser({ email: "op-revert-cascade@teste.local" });

    await descendQueueCascade({
      sourceLh: "LT-1",
      targetLh: "LT-2",
      orderedLhs: ["LT-1", "LT-2", "LT-3"],
      operatorId: op.id,
      correlationId: "c-desc",
    });
    // Pós-cascata: LT-1 vazia, LT-2=M1, LT-3=M2.
    expect((await getAlloc(id1)).alloc_motorista).toBe("");
    expect((await getAlloc(id2)).alloc_motorista).toBe("M1");
    expect((await getAlloc(id3)).alloc_motorista).toBe("M2");

    const list = await listOperatorAllocationChanges({ operatorId: op.id, query: {} });
    const ev = list.payload.items.find((i) => i.eventType === "operator.cargo.queue_descended");
    expect(ev).toBeTruthy();
    expect(ev.revertible).toBe(true);
    expect(ev.reserva).toBe(true); // sobrou M3 → standby (aviso no modal)

    const res = await revertAllocationChanges({
      operatorId: op.id,
      items: ev.cargos.map((c) => ({ auditLogId: ev.auditLogId, lh: c.lh })),
      correlationId: "c-revert",
    });
    expect(res.payload.revertedCount).toBe(ev.cargos.length);

    // Restaurado ao estado pré-cascata (materializado em alloc_*).
    expect((await getAlloc(id1)).alloc_motorista).toBe("M1");
    expect((await getAlloc(id2)).alloc_motorista).toBe("M2");
    expect((await getAlloc(id3)).alloc_motorista).toBe("M3");
  });
});

// Gêmea já mergeada (TWIN_MERGE): o cargoId gravado num audit ANTIGO pode ser hoje
// uma PERDEDORA (merge-launched-twin.js só marca, nunca apaga). Ler/travar essa
// linha direto compara/escreve num estado CONGELADO em vez do efetivo e visível.
describe("list + revert — cargoId aponta pra uma gêmea já mergeada", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.TWIN_MERGE;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  async function seedReassignEvent({ operatorId, cargoId, before, after }) {
    let auditLogId = null;
    await withPgTransaction(async (client) => {
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cargo.allocation_reassigned",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "cargo",
        resourceId: cargoId,
        action: "update",
        outcome: "success",
        metadata: {
          moves: [{ cargoId, motorista: after, cavalo: null, carreta: null }],
          beforeMoves: [{ cargoId, motorista: before, cavalo: null, carreta: null }],
        },
      });
      const { rows } = await client.query(
        `SELECT id FROM public.security_audit_logs WHERE event_type = 'operator.cargo.allocation_reassigned' ORDER BY created_at DESC LIMIT 1`,
      );
      auditLogId = rows[0].id;
    });
    return auditLogId;
  }

  it("list: currentMatchesAfter segue a vencedora (não a perdedora congelada) quando os valores divergem", async () => {
    const op = await seedUser({ email: "op-list-merge@teste.local" });
    const winnerId = createSheetLoadId("LT-LISTMERGE");
    await seedCargo({ id: winnerId, sheet_lh: "LT-LISTMERGE", status: "OPEN" });
    // Vencedora com decisão PRÓPRIA mais recente — o merge não deve sobrescrevê-la.
    await query(
      `UPDATE public.cargas SET alloc_motorista = 'MARIA', alloc_updated_at = now() WHERE id = $1`,
      [winnerId],
    );
    const { id: loserId } = await seedCargo({ sheet_lh: null, status: "RESERVED" });
    await query(
      `UPDATE public.cargas SET lh_manual = 'LT-LISTMERGE', alloc_motorista = 'PEDRO',
              alloc_updated_at = now() - interval '1 hour' WHERE id = $1`,
      [loserId],
    );

    const auditLogId = await seedReassignEvent({ operatorId: op.id, cargoId: loserId, before: "JOAO", after: "PEDRO" });

    process.env.TWIN_MERGE = "on";
    const merge = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh: "LT-LISTMERGE", winnerId }));
    expect(merge.skipped).toBe("nada_a_migrar"); // vencedora era mais nova — não copiou
    expect((await getAlloc(winnerId)).alloc_motorista).toBe("MARIA"); // preservada

    const list = await listOperatorAllocationChanges({ operatorId: op.id, query: {} });
    const ev = list.payload.items.find((i) => i.auditLogId === auditLogId);
    expect(ev).toBeTruthy();
    // A carga efetiva/visível (vencedora) é "MARIA", não "PEDRO" — a ação gravada
    // não bate mais com o estado atual: NÃO é seguro reverter.
    expect(ev.cargos[0].currentMatchesAfter).toBe(false);
    expect(ev.revertible).toBe(false);
  });

  it("revert: segue o ponteiro de merge e escreve na VENCEDORA (visível), não na perdedora morta", async () => {
    const op = await seedUser({ email: "op-revert-merge@teste.local" });
    const winnerId = createSheetLoadId("LT-REVMERGE");
    await seedCargo({ id: winnerId, sheet_lh: "LT-REVMERGE", status: "OPEN" });
    const { id: loserId } = await seedCargo({ sheet_lh: null, status: "RESERVED" });
    await query(
      `UPDATE public.cargas SET lh_manual = 'LT-REVMERGE', alloc_motorista = 'PEDRO', alloc_updated_at = now() WHERE id = $1`,
      [loserId],
    );

    const auditLogId = await seedReassignEvent({ operatorId: op.id, cargoId: loserId, before: "JOAO", after: "PEDRO" });

    process.env.TWIN_MERGE = "on";
    const merge = await withPgTransaction((c) => mergeLaunchedTwinAlloc(c, { lh: "LT-REVMERGE", winnerId }));
    expect(merge.merged).toBe(true); // vencedora sem decisão própria → herdou "PEDRO"
    expect((await getAlloc(winnerId)).alloc_motorista).toBe("PEDRO");

    const res = await revertAllocationChanges({
      operatorId: op.id,
      items: [{ auditLogId, cargoId: loserId }],
      correlationId: "c-revert-merge",
    });
    expect(res.payload.revertedCount).toBe(1);
    expect(res.payload.skippedCount).toBe(0);

    // A VENCEDORA (linha efetiva/visível) foi restaurada...
    expect((await getAlloc(winnerId)).alloc_motorista).toBe("JOAO");
    // ...a perdedora morta NUNCA é escrita (pré-imagem preservada, como documentado
    // em merge-launched-twin.js).
    expect((await getAlloc(loserId)).alloc_motorista).toBe("PEDRO");
  });
});
