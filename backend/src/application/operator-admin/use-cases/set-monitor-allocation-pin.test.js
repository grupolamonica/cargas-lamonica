import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { setMonitorAllocationPin } = await import("./set-monitor-allocation-pin.js");

async function seedSheetCargo(lh) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN" });
  return id;
}

async function getPin(id) {
  const { rows } = await query(
    `SELECT alloc_pinned, alloc_pinned_at, alloc_pinned_by, alloc_source FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("setMonitorAllocationPin", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("fixa a carga: alloc_pinned=true + pinned_at/by preenchidos", async () => {
    const id = await seedSheetCargo("LH-PIN");
    const operator = await seedUser({ email: "op-pin@teste.local" });

    const res = await setMonitorAllocationPin({
      lh: "LH-PIN",
      pinned: true,
      operatorId: operator.id,
      correlationId: "corr-pin-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.pinned).toBe(true);
    const row = await getPin(id);
    expect(row.alloc_pinned).toBe(true);
    expect(row.alloc_pinned_at).not.toBeNull();
    expect(row.alloc_pinned_by).toBe(operator.id);
    expect(row.alloc_source).toBe("operator");
  });

  it("desafixa: alloc_pinned=false + limpa pinned_at/by", async () => {
    const id = await seedSheetCargo("LH-UNPIN");
    const operator = await seedUser({ email: "op-unpin@teste.local" });
    await setMonitorAllocationPin({ lh: "LH-UNPIN", pinned: true, operatorId: operator.id });

    await setMonitorAllocationPin({ lh: "LH-UNPIN", pinned: false, operatorId: operator.id });

    const row = await getPin(id);
    expect(row.alloc_pinned).toBe(false);
    expect(row.alloc_pinned_at).toBeNull();
    expect(row.alloc_pinned_by).toBeNull();
  });

  it("lança NotFoundError quando o LH não tem carga", async () => {
    const operator = await seedUser({ email: "op-pin-404@teste.local" });
    await expect(
      setMonitorAllocationPin({ lh: "LH-INEXISTENTE", pinned: true, operatorId: operator.id }),
    ).rejects.toThrow();
  });
});
