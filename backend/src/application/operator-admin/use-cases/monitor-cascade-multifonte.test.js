// Cascata (descer fila / cancelamento) e "últimas mudanças" em cenário MULTI-PLANILHA.
//
// O id da carga de planilha é namespaced por fonte (createSheetLoadId). Derivando
// tudo no namespace da Shopee, a carga Nestlé ficava FORA da query travada: a
// descida dava 404 (origem Nestlé) ou pulava a carga em silêncio (miolo/destino
// Nestlé), embaralhando a cascata; e a cascata de cancelamento nem achava a carga
// gatilho.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

// Write-back pra planilha é irrelevante aqui (e não deve sair de verdade).
vi.mock("../../google-sheets/sheet-writeback.js", async (importOriginal) => ({
  ...(await importOriginal()),
  writeAllocationsToSheet: vi.fn(async () => {}),
}));

const { descendQueueCascade: descend } = await import("./descend-queue-cascade.js");
const { cancelLoadCascade: cancelCascade } = await import("./cancel-load-cascade.js");

const harness = { query, resetTestDatabase, seedUser };

const ROTA = { origem: "FEIRA DE SANTANA/BA", destino: "SIMOES FILHO/BA" };

async function seedSheetCargo({ lh, source, data, motorista = "", status = "" }) {
  const id = createSheetLoadId(lh, source ?? undefined);
  await harness.query(
    `INSERT INTO public.cargas
       (id, cliente_id, data, horario, origem, destino, perfil, status, is_template,
        driver_visibility, sheet_lh, sheet_source, sheet_motorista, sheet_status, alloc_pinned)
     VALUES ($1, NULL, $2, '08:00', $3, $4, 'CARRETA', 'OPEN', false,
             'PUBLIC', $5, $6, $7, $8, false)`,
    [id, data, ROTA.origem, ROTA.destino, lh, source, motorista, status],
  );
  return id;
}

async function allocOf(id) {
  const { rows } = await harness.query(
    "SELECT COALESCE(alloc_motorista,'(null)') AS m FROM public.cargas WHERE id = $1",
    [id],
  );
  return rows[0]?.m ?? null;
}

describe.sequential("descendQueueCascade — multi-planilha", () => {
  beforeEach(async () => {
    await harness.resetTestDatabase();
  });

  it("descer a fila de uma rota NESTLÉ funciona quando a fonte vai no mapa", async () => {
    // Fila (topo→base pela data DESC): A (motorista) e B (vazia).
    const idA = await seedSheetCargo({ lh: "B101000001", source: "nestle", data: "2026-08-10", motorista: "MOTORISTA A" });
    const idB = await seedSheetCargo({ lh: "B101000002", source: "nestle", data: "2026-08-09" });
    const op = await harness.seedUser({ email: "op-desc-nestle@test.local" });

    const res = await descend({
      sourceLh: "B101000001",
      targetLh: "B101000002",
      orderedLhs: ["B101000001", "B101000002"],
      sourceByLh: { B101000001: "nestle", B101000002: "nestle" },
      operatorId: op.id,
      correlationId: "c-desc-nestle",
    });

    expect(res.statusCode).toBe(200);
    // O motorista de A assume B; A fica vazia (vazio EXPLÍCITO).
    expect(await allocOf(idB)).toBe("MOTORISTA A");
    expect(await allocOf(idA)).toBe("");
  });

  it("SEM o mapa, a mesma fila Nestlé é recusada (não embaralha em silêncio)", async () => {
    await seedSheetCargo({ lh: "B101000001", source: "nestle", data: "2026-08-10", motorista: "MOTORISTA A" });
    await seedSheetCargo({ lh: "B101000002", source: "nestle", data: "2026-08-09" });
    const op = await harness.seedUser({ email: "op-desc-sem-mapa@test.local" });

    await expect(
      descend({
        sourceLh: "B101000001",
        targetLh: "B101000002",
        orderedLhs: ["B101000001", "B101000002"],
        operatorId: op.id,
        correlationId: "c-desc-sem-mapa",
      }),
    ).rejects.toThrow();
  });

  it("fila da SHOPEE segue funcionando sem mapa (comportamento histórico)", async () => {
    const idA = await seedSheetCargo({ lh: "LT000000001", source: "shopee", data: "2026-08-10", motorista: "MOTORISTA S" });
    const idB = await seedSheetCargo({ lh: "LT000000002", source: "shopee", data: "2026-08-09" });
    const op = await harness.seedUser({ email: "op-desc-shopee@test.local" });

    const res = await descend({
      sourceLh: "LT000000001",
      targetLh: "LT000000002",
      orderedLhs: ["LT000000001", "LT000000002"],
      operatorId: op.id,
      correlationId: "c-desc-shopee",
    });

    expect(res.statusCode).toBe(200);
    expect(await allocOf(idB)).toBe("MOTORISTA S");
    expect(await allocOf(idA)).toBe("");
  });
});

describe.sequential("cancelLoadCascade — multi-planilha", () => {
  beforeEach(async () => {
    await harness.resetTestDatabase();
  });

  it("cascata de cancelamento numa carga NESTLÉ acha a gatilho e remaneja", async () => {
    const idCancelada = await seedSheetCargo({
      lh: "B101000010",
      source: "nestle",
      data: "2026-08-10",
      motorista: "MOTORISTA X",
      status: "CANCELADO",
    });
    const idAbaixo = await seedSheetCargo({ lh: "B101000011", source: "nestle", data: "2026-08-09" });
    const op = await harness.seedUser({ email: "op-cancel-nestle@test.local" });

    const res = await cancelCascade({
      lh: "B101000010",
      sheetSource: "nestle",
      operatorId: op.id,
      correlationId: "c-cancel-nestle",
    });

    expect(res.payload.cascaded).toBe(true);
    expect(await allocOf(idAbaixo)).toBe("MOTORISTA X");
    expect(await allocOf(idCancelada)).toBe("");
  });

  it("sem a fonte, a carga NESTLÉ gatilho não é encontrada (404 honesto)", async () => {
    await seedSheetCargo({
      lh: "B101000010",
      source: "nestle",
      data: "2026-08-10",
      motorista: "MOTORISTA X",
      status: "CANCELADO",
    });
    const op = await harness.seedUser({ email: "op-cancel-sem-fonte@test.local" });

    await expect(
      cancelCascade({ lh: "B101000010", operatorId: op.id, correlationId: "c-cancel-sem-fonte" }),
    ).rejects.toThrow(/não encontrada/i);
  });

  // A fila da rota é escopada pela fonte da carga gatilho: a fila da Nestlé e a da
  // Shopee na mesma rota são operações diferentes. (Nenhuma rota em produção tem as
  // duas hoje — é barreira.)
  it("a fila remanejada é escopada pela fonte: carga Shopee da MESMA rota não é tocada", async () => {
    const idNestleCancelada = await seedSheetCargo({
      lh: "B101000020",
      source: "nestle",
      data: "2026-08-10",
      motorista: "MOTORISTA NESTLE",
      status: "CANCELADO",
    });
    const idNestleAbaixo = await seedSheetCargo({ lh: "B101000021", source: "nestle", data: "2026-08-09" });
    const idShopeeAbaixo = await seedSheetCargo({ lh: "LT000000020", source: "shopee", data: "2026-08-08" });
    const op = await harness.seedUser({ email: "op-cancel-escopo@test.local" });

    await cancelCascade({
      lh: "B101000020",
      sheetSource: "nestle",
      operatorId: op.id,
      correlationId: "c-cancel-escopo",
    });

    expect(await allocOf(idNestleAbaixo)).toBe("MOTORISTA NESTLE");
    expect(await allocOf(idNestleCancelada)).toBe("");
    // A Shopee da mesma rota fica intacta (nem recebeu o motorista da Nestlé).
    expect(await allocOf(idShopeeAbaixo)).toBe("(null)");
  });
});

afterAll(async () => {
  await closeTestDatabase();
});
