import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const directory = { current: new Map() };
vi.mock("./audit-logs-read-model.js", () => ({
  resolveOperatorDirectory: async () => directory.current,
}));

const { fetchCargoHistoryByLh } = await import("./fetch-cargo-history.js");
const { mergeLaunchedTwinAlloc } = await import("./merge-launched-twin.js");

// O merge (TWIN_MERGE) não reescreve o passado — só marca a perdedora
// (merge-launched-twin.js). Sem costurar o histórico na LEITURA (união de
// resource_id), a alocação feita no sistema ANTES do merge, gravada com
// resource_id = id da carga LANÇADA, desaparecia do modal assim que a gêmea
// era unificada na canônica.
describe("fetchCargoHistoryByLh — gêmea já mergeada (TWIN_MERGE)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    directory.current = new Map();
  });
  afterEach(() => {
    delete process.env.TWIN_MERGE;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  const LH = "LT-HIST-MERGE";

  async function seedGemeaMergeada() {
    const op = await seedUser({ email: "op-hist-merge@teste.local" });
    const winnerId = createSheetLoadId(LH);
    await seedCargo({ id: winnerId, sheet_lh: LH, status: "OPEN" });
    const { id: loserId } = await seedCargo({ sheet_lh: null, status: "RESERVED" });
    await query(
      `UPDATE public.cargas SET lh_manual = $2, alloc_motorista = 'FERNANDO', alloc_updated_at = now(), alloc_updated_by = $3 WHERE id = $1`,
      [loserId, LH, op.id],
    );

    // Alocação feita no sistema ANTES do merge — audit no id da carga LANÇADA (a
    // que vai virar perdedora), como acontecia sempre antes deste PR.
    await withPgTransaction((client) =>
      insertSecurityAuditEvent(client, {
        eventType: "operator.cargo.allocation_updated",
        actorUserId: op.id,
        actorRole: "operator",
        resourceType: "cargo",
        resourceId: loserId,
        action: "update",
        outcome: "success",
        metadata: { changes: [{ field: "motorista", label: "Motorista", before: null, after: "FERNANDO" }] },
      }),
    );

    process.env.TWIN_MERGE = "on";
    const result = await withPgTransaction((client) => mergeLaunchedTwinAlloc(client, { lh: LH, winnerId }));
    expect(result.merged).toBe(true);

    return { winnerId, loserId, op };
  }

  it("mostra a alocação feita no sistema ANTES do merge (audit gravado na perdedora)", async () => {
    await seedGemeaMergeada();
    const { items } = (await fetchCargoHistoryByLh({ lh: LH, correlationId: "c1" })).payload;
    const allocAudit = items.filter((i) => i.tipo === "ALLOC_AUDIT");
    expect(allocAudit).toHaveLength(1);
    expect(allocAudit[0].detalhe).toBe("Motorista: vazio → FERNANDO");
  });

  it("mostra o próprio evento de unificação das gêmeas", async () => {
    await seedGemeaMergeada();
    const { items } = (await fetchCargoHistoryByLh({ lh: LH, correlationId: "c2" })).payload;
    const merged = items.find((i) => i.tipo === "TWIN_MERGED");
    expect(merged).toBeTruthy();
    expect(merged.titulo).toBe("Gêmeas unificadas");
    expect(merged.detalhe).toContain("motorista");
    expect(merged.por).toBe("Sistema (automático)");
  });

  it("sem gêmea mergeada: comportamento igual a antes (só o resource_id da própria canônica)", async () => {
    const op = await seedUser({ email: "op-hist-nomerge@teste.local" });
    const cargoId = createSheetLoadId("LT-HIST-SOLO");
    await seedCargo({ id: cargoId, sheet_lh: "LT-HIST-SOLO", status: "OPEN" });
    await withPgTransaction((client) =>
      insertSecurityAuditEvent(client, {
        eventType: "operator.cargo.allocation_updated",
        actorUserId: op.id,
        actorRole: "operator",
        resourceType: "cargo",
        resourceId: cargoId,
        action: "update",
        outcome: "success",
        metadata: { changes: [{ field: "motorista", label: "Motorista", before: null, after: "MARIA" }] },
      }),
    );

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT-HIST-SOLO", correlationId: "c3" })).payload;
    const allocAudit = items.filter((i) => i.tipo === "ALLOC_AUDIT");
    expect(allocAudit).toHaveLength(1);
    expect(allocAudit[0].detalhe).toBe("Motorista: vazio → MARIA");
    expect(items.find((i) => i.tipo === "TWIN_MERGED")).toBeUndefined();
  });
});
