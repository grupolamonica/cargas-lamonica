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

const { setMonitorRodoparStatus } = await import("./set-monitor-rodopar-status.js");

const getStatus = async (id) =>
  (await query(`SELECT rodopar_status, rodopar_updated_at, rodopar_updated_by FROM public.cargas WHERE id = $1`, [id])).rows[0];

describe("setMonitorRodoparStatus (DC-260)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("marca por lh (carga da planilha): rodopar_status=1 + metadados", async () => {
    const id = createSheetLoadId("LH-ROD");
    await seedCargo({ id, sheet_lh: "LH-ROD", status: "OPEN" });
    const op = await seedUser({ email: "op-rod@teste.local" });

    const res = await setMonitorRodoparStatus({ lh: "LH-ROD", status: 1, operatorId: op.id, correlationId: "c1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.rodoparStatus).toBe(1);
    const row = await getStatus(id);
    expect(row.rodopar_status).toBe(1);
    expect(row.rodopar_updated_at).not.toBeNull();
    expect(row.rodopar_updated_by).toBe(op.id);
  });

  it("marca por cargoId (carga do sistema): rodopar_status=2", async () => {
    const cargo = await seedCargo({ status: "OPEN", lh_manual: "LT-SYS" });
    const op = await seedUser({ email: "op-rod-sys@teste.local" });

    await setMonitorRodoparStatus({ cargoId: cargo.id, status: 2, operatorId: op.id });

    expect((await getStatus(cargo.id)).rodopar_status).toBe(2);
  });

  it("rejeita status inválido (fora de 0..2)", async () => {
    const op = await seedUser({ email: "op-rod-inv@teste.local" });
    await expect(setMonitorRodoparStatus({ lh: "X", status: 3, operatorId: op.id })).rejects.toThrow();
  });

  it("rejeita sem lh nem cargoId", async () => {
    const op = await seedUser({ email: "op-rod-none@teste.local" });
    await expect(setMonitorRodoparStatus({ status: 1, operatorId: op.id })).rejects.toThrow();
  });

  it("lança NotFoundError quando a carga não existe", async () => {
    const op = await seedUser({ email: "op-rod-404@teste.local" });
    await expect(setMonitorRodoparStatus({ lh: "LH-INEXISTENTE", status: 1, operatorId: op.id })).rejects.toThrow();
  });
});
