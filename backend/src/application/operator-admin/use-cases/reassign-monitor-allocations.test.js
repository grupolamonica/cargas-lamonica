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

const { reassignMonitorAllocations } = await import("./reassign-monitor-allocations.js");

async function seedSheetCargo(lh, { motorista, status } = {}) {
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN" });
  await query(`UPDATE public.cargas SET sheet_motorista = $2, sheet_status = $3 WHERE id = $1`, [
    id,
    motorista ?? null,
    status ?? null,
  ]);
  return id;
}

async function getAlloc(id) {
  const { rows } = await query(
    `SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_source, alloc_updated_at, sheet_motorista
     FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("reassignMonitorAllocations", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("aplica a permutação (troca de motoristas entre cargas) gravando alloc_*", async () => {
    const idA = await seedSheetCargo("LH-A", { motorista: "MOTORISTA A" });
    const idB = await seedSheetCargo("LH-B", { motorista: "MOTORISTA B" });
    const operator = await seedUser({ email: "op-reassign@teste.local" });

    const res = await reassignMonitorAllocations({
      moves: [
        { lh: "LH-A", motorista: "MOTORISTA B", cavalo: "BBB2B22", carreta: "" },
        { lh: "LH-B", motorista: "MOTORISTA A", cavalo: "AAA1A11", carreta: "" },
      ],
      operatorId: operator.id,
      correlationId: "corr-reassign-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload.count).toBe(2);

    const a = await getAlloc(idA);
    const b = await getAlloc(idB);
    expect(a.alloc_motorista).toBe("MOTORISTA B");
    expect(a.alloc_cavalo).toBe("BBB2B22");
    expect(a.alloc_source).toBe("operator");
    expect(b.alloc_motorista).toBe("MOTORISTA A");
    expect(b.alloc_cavalo).toBe("AAA1A11");
    // sheet_* permanece intocado
    expect(a.sheet_motorista).toBe("MOTORISTA A");
    expect(b.sheet_motorista).toBe("MOTORISTA B");
  });

  it('grava "" como vazio EXPLÍCITO (não null) — linha esvaziada na reordenação', async () => {
    const id = await seedSheetCargo("LH-EMPTY", { motorista: "MOTORISTA PLANILHA" });
    const operator = await seedUser({ email: "op-reassign-empty@teste.local" });

    await reassignMonitorAllocations({
      moves: [{ lh: "LH-EMPTY", motorista: "", cavalo: "", carreta: "" }],
      operatorId: operator.id,
      correlationId: "corr-reassign-empty",
    });

    const row = await getAlloc(id);
    // "" explícito (sobrepõe a planilha), diferente de null (que voltaria à planilha)
    expect(row.alloc_motorista).toBe("");
    expect(row.alloc_cavalo).toBe("");
    expect(row.alloc_carreta).toBe("");
    expect(row.alloc_source).toBe("operator");
  });

  it("não toca alloc_status ao mover motorista/placa", async () => {
    const id = await seedSheetCargo("LH-STATUS", { motorista: "X" });
    await query(`UPDATE public.cargas SET alloc_status = 'CARREGADO' WHERE id = $1`, [id]);
    const operator = await seedUser({ email: "op-reassign-status@teste.local" });

    await reassignMonitorAllocations({
      moves: [{ lh: "LH-STATUS", motorista: "NOVO MOTORISTA" }],
      operatorId: operator.id,
      correlationId: "corr-reassign-status",
    });

    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("NOVO MOTORISTA");
    expect(row.alloc_status).toBe("CARREGADO"); // preservado
  });

  it("lança NotFoundError quando algum LH não tem carga correspondente", async () => {
    const operator = await seedUser({ email: "op-reassign-404@teste.local" });
    await expect(
      reassignMonitorAllocations({
        moves: [{ lh: "LH-INEXISTENTE", motorista: "X" }],
        operatorId: operator.id,
        correlationId: "corr-reassign-404",
      }),
    ).rejects.toThrow();
  });

  it("rejeita LH repetido na mesma movimentação", async () => {
    await seedSheetCargo("LH-DUP", { motorista: "X" });
    const operator = await seedUser({ email: "op-reassign-dup@teste.local" });
    await expect(
      reassignMonitorAllocations({
        moves: [
          { lh: "LH-DUP", motorista: "A" },
          { lh: "LH-DUP", motorista: "B" },
        ],
        operatorId: operator.id,
        correlationId: "corr-reassign-dup",
      }),
    ).rejects.toThrow();
  });

  it("rejeita lista de movimentações vazia", async () => {
    const operator = await seedUser({ email: "op-reassign-vazio@teste.local" });
    await expect(
      reassignMonitorAllocations({ moves: [], operatorId: operator.id, correlationId: "corr-reassign-vazio" }),
    ).rejects.toThrow();
  });

  it("rejeita mover uma carga FIXA (alloc_pinned) sem alterar nada", async () => {
    const idFixa = await seedSheetCargo("LH-FIXA", { motorista: "FIXO" });
    const idLivre = await seedSheetCargo("LH-LIVRE", { motorista: "LIVRE" });
    await query(`UPDATE public.cargas SET alloc_pinned = true WHERE id = $1`, [idFixa]);
    const operator = await seedUser({ email: "op-reassign-pin@teste.local" });

    await expect(
      reassignMonitorAllocations({
        moves: [
          { lh: "LH-FIXA", motorista: "LIVRE" },
          { lh: "LH-LIVRE", motorista: "FIXO" },
        ],
        operatorId: operator.id,
        correlationId: "corr-reassign-pin",
      }),
    ).rejects.toThrow(/fixada/i);

    // Transação inteira revertida — nenhuma das duas mudou.
    const fixa = await getAlloc(idFixa);
    const livre = await getAlloc(idLivre);
    expect(fixa.alloc_motorista).toBeNull();
    expect(livre.alloc_motorista).toBeNull();
  });
});
