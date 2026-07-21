import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { setMonitorRodoparStatus } = await import("./set-monitor-rodopar-status.js");

const getStatus = async (lh) =>
  (await query(`SELECT status, updated_by FROM public.monitor_rodopar_status WHERE lh = $1`, [lh])).rows[0];

describe("setMonitorRodoparStatus (DC-260 — por LH)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("grava por LH mesmo SEM carga (o caso que quebrava): upsert em monitor_rodopar_status", async () => {
    const op = await seedUser({ email: "op-rod@teste.local" });
    // Nenhuma carga com esse LH — antes dava "Carga não encontrada".
    const res = await setMonitorRodoparStatus({ lh: "LH-SEM-CARGA", status: 1, operatorId: op.id, correlationId: "c1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.rodoparStatus).toBe(1);
    const row = await getStatus("LH-SEM-CARGA");
    expect(row.status).toBe(1);
    expect(row.updated_by).toBe(op.id);
  });

  it("alterna (ON CONFLICT) o status do mesmo LH", async () => {
    const op = await seedUser({ email: "op-rod2@teste.local" });
    await setMonitorRodoparStatus({ lh: "LH-X", status: 1, operatorId: op.id });
    await setMonitorRodoparStatus({ lh: "LH-X", status: 2, operatorId: op.id });
    expect((await getStatus("LH-X")).status).toBe(2);
    await setMonitorRodoparStatus({ lh: "LH-X", status: 0, operatorId: op.id });
    expect((await getStatus("LH-X")).status).toBe(0);
  });

  it("rejeita status inválido (fora de 0..2)", async () => {
    const op = await seedUser({ email: "op-rod-inv@teste.local" });
    await expect(setMonitorRodoparStatus({ lh: "LH-Y", status: 3, operatorId: op.id })).rejects.toThrow();
  });

  it("rejeita LH vazio", async () => {
    const op = await seedUser({ email: "op-rod-none@teste.local" });
    await expect(setMonitorRodoparStatus({ lh: "  ", status: 1, operatorId: op.id })).rejects.toThrow();
  });
});
