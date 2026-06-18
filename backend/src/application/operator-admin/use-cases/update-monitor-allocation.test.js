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

const { updateMonitorAllocation } = await import("./update-monitor-allocation.js");

const LH = "LT-MONITOR-TEST-1";

async function seedSheetCargo() {
  // Carga oriunda da planilha: id determinístico = createSheetLoadId(lh).
  const id = createSheetLoadId(LH);
  await seedCargo({ id, sheet_lh: LH, status: "OPEN" });
  // seedCargo não insere sheet_motorista/sheet_status — setamos direto.
  await query(`UPDATE public.cargas SET sheet_motorista = $2, sheet_status = $3 WHERE id = $1`, [
    id,
    "MOTORISTA DA PLANILHA",
    "AGUARDANDO CARREGAMENTO",
  ]);
  return id;
}

async function getAlloc(id) {
  const { rows } = await query(
    `SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_source, alloc_updated_at,
            sheet_motorista, sheet_status
     FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("updateMonitorAllocation", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("grava a alocação do operador em alloc_* sem tocar nos campos sheet_*", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor@teste.local" });

    const res = await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "JOAO AGREGADO", cavalo: "ABC1D23", carreta: "DEF4G56", status: "DESCARREGADO" },
      requestIp: "203.0.113.10",
      correlationId: "corr-monitor-1",
    });

    expect(res.statusCode).toBe(200);
    const row = await getAlloc(id);
    // alloc_* recebe a decisão do operador
    expect(row.alloc_motorista).toBe("JOAO AGREGADO");
    expect(row.alloc_cavalo).toBe("ABC1D23");
    expect(row.alloc_carreta).toBe("DEF4G56");
    expect(row.alloc_status).toBe("DESCARREGADO");
    expect(row.alloc_source).toBe("operator");
    expect(row.alloc_updated_at).toBeTruthy();
    // sheet_* (espelho da planilha) permanece intocado
    expect(row.sheet_motorista).toBe("MOTORISTA DA PLANILHA");
    expect(row.sheet_status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("normaliza string vazia para null (limpa o override e volta a refletir a planilha)", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-clear@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "", cavalo: "  ", carreta: null, status: "" },
      correlationId: "corr-monitor-clear",
    });

    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBeNull();
    expect(row.alloc_cavalo).toBeNull();
    expect(row.alloc_carreta).toBeNull();
    expect(row.alloc_status).toBeNull();
    // sheet_* segue intocado
    expect(row.sheet_motorista).toBe("MOTORISTA DA PLANILHA");
  });

  it("lança NotFoundError quando o LH não tem carga correspondente", async () => {
    const operator = await seedUser({ email: "op-monitor-404@teste.local" });
    await expect(
      updateMonitorAllocation({
        lh: "LH-INEXISTENTE",
        operatorId: operator.id,
        payload: { motorista: "X" },
        correlationId: "corr-monitor-404",
      }),
    ).rejects.toThrow();
  });
});
