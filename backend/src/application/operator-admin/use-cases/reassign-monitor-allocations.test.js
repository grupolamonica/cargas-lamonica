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

  it("rejeita reordenar entre ROTAS diferentes (só mesma rota)", async () => {
    const idA = createSheetLoadId("LH-ROTA-A");
    const idB = createSheetLoadId("LH-ROTA-B");
    await seedCargo({ id: idA, sheet_lh: "LH-ROTA-A", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA" });
    await seedCargo({ id: idB, sheet_lh: "LH-ROTA-B", status: "OPEN", origem: "Recife / PE", destino: "Olinda / PE" });
    await query(`UPDATE public.cargas SET sheet_motorista = 'A' WHERE id = $1`, [idA]);
    await query(`UPDATE public.cargas SET sheet_motorista = 'B' WHERE id = $1`, [idB]);
    const operator = await seedUser({ email: "op-reassign-rota@teste.local" });

    await expect(
      reassignMonitorAllocations({
        moves: [
          { lh: "LH-ROTA-A", motorista: "B" },
          { lh: "LH-ROTA-B", motorista: "A" },
        ],
        operatorId: operator.id,
        correlationId: "corr-reassign-rota",
      }),
    ).rejects.toThrow(/mesma rota/i);

    // Nada gravado (validação antes de qualquer escrita).
    const a = await getAlloc(idA);
    const b = await getAlloc(idB);
    expect(a.alloc_motorista).toBeNull();
    expect(b.alloc_motorista).toBeNull();
  });

  it("permite reordenar dentro da MESMA rota", async () => {
    const idA = createSheetLoadId("LH-MESMA-A");
    const idB = createSheetLoadId("LH-MESMA-B");
    await seedCargo({ id: idA, sheet_lh: "LH-MESMA-A", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA" });
    await seedCargo({ id: idB, sheet_lh: "LH-MESMA-B", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA" });
    const operator = await seedUser({ email: "op-reassign-mesma@teste.local" });

    const res = await reassignMonitorAllocations({
      moves: [
        { lh: "LH-MESMA-A", motorista: "B" },
        { lh: "LH-MESMA-B", motorista: "A" },
      ],
      operatorId: operator.id,
      correlationId: "corr-reassign-mesma",
    });
    expect(res.payload.count).toBe(2);
    expect((await getAlloc(idA)).alloc_motorista).toBe("B");
    expect((await getAlloc(idB)).alloc_motorista).toBe("A");
  });
});
