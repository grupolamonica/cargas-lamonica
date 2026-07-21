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
// Write-back é best-effort (fora da transação, sem await) — mocka p/ não sair pela rede.
vi.mock("../../google-sheets/sheet-writeback.js", () => ({ writeAllocationsToSheet: vi.fn().mockResolvedValue(undefined) }));

const { descendQueueCascade } = await import("./descend-queue-cascade.js");

const ROUTE = { origem: "Salvador / BA", destino: "Feira / BA" };
const OTHER_ROUTE = { origem: "Recife / PE", destino: "Olinda / PE" };

async function seedRouteCargo(lh, { motorista, horario, status, pinned, route } = {}) {
  const r = route ?? ROUTE;
  const id = createSheetLoadId(lh);
  await seedCargo({ id, sheet_lh: lh, status: "OPEN", origem: r.origem, destino: r.destino, horario: horario ?? "08:00:00" });
  await query(
    `UPDATE public.cargas SET alloc_motorista = $2, sheet_status = $3, alloc_pinned = $4 WHERE id = $1`,
    [id, motorista ?? null, status ?? null, pinned ?? false],
  );
  return id;
}

// Carga LANÇADA na Programação: id ALEATÓRIO, sheet_lh NULL, lh_manual = LH.
async function seedLaunchedRouteCargo(lhManual, { motorista, horario, route } = {}) {
  const r = route ?? ROUTE;
  const { id } = await seedCargo({ status: "OPEN", origem: r.origem, destino: r.destino, horario: horario ?? "08:00:00" });
  await query(`UPDATE public.cargas SET lh_manual = $2, alloc_motorista = $3 WHERE id = $1`, [id, lhManual, motorista ?? null]);
  return id;
}

const allocMotorista = async (id) => (await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [id])).rows[0].alloc_motorista;
const reservas = async () => (await query(`SELECT * FROM public.monitor_reservas WHERE active = true`)).rows;

describe("descendQueueCascade", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("solto ABAIXO: motorista assume o destino, empurra os de baixo, vaga em branco absorve (sem reserva)", async () => {
    // Fila (orderedLhs topo→base): Q1(JOAO) · Q2(MARIA) · Q3(vazio). Solto Q1 em Q2.
    const c1 = await seedRouteCargo("Q1", { motorista: "JOAO" });
    const c2 = await seedRouteCargo("Q2", { motorista: "MARIA" });
    const c3 = await seedRouteCargo("Q3", { motorista: null });
    const op = await seedUser({ email: "op-descend@teste.local" });

    const res = await descendQueueCascade({ sourceLh: "Q1", targetLh: "Q2", orderedLhs: ["Q1", "Q2", "Q3"], operatorId: op.id, correlationId: "c-1" });

    expect(res.payload.ok).toBe(true);
    expect(res.payload.reserva).toBe(false);
    expect(await allocMotorista(c1)).toBe("");     // origem vaga
    expect(await allocMotorista(c2)).toBe("JOAO");  // assumiu o destino
    expect(await allocMotorista(c3)).toBe("MARIA"); // desceu p/ a vaga
    expect(await reservas()).toHaveLength(0);
  });

  it("solto ABAIXO com fila cheia: o motorista do fim sobra → reserva; origem esvazia", async () => {
    const c1 = await seedRouteCargo("R1", { motorista: "JOAO" });
    const c2 = await seedRouteCargo("R2", { motorista: "MARIA" });
    const c3 = await seedRouteCargo("R3", { motorista: "PEDRO" });
    const op = await seedUser({ email: "op-descend-cheia@teste.local" });

    const res = await descendQueueCascade({ sourceLh: "R1", targetLh: "R2", orderedLhs: ["R1", "R2", "R3"], operatorId: op.id });

    expect(res.payload.reserva).toBe(true);
    expect(await allocMotorista(c1)).toBe("");
    expect(await allocMotorista(c2)).toBe("JOAO");
    expect(await allocMotorista(c3)).toBe("MARIA");
    const r = await reservas();
    expect(r).toHaveLength(1);
    expect(r[0].motorista).toBe("PEDRO");
    expect(r[0].origin_lh).toBe("R1");
  });

  it("solto ACIMA (subir/promover): rotação em volta da fixada, sem reserva", async () => {
    // Fila: U0(CARLOS) · U1(ANA) · U2(PEDRO, FIXA) · U3(JOAO). Arrasto U3 → solto em U0 (topo).
    const c0 = await seedRouteCargo("U0", { motorista: "CARLOS" });
    const c1 = await seedRouteCargo("U1", { motorista: "ANA" });
    const c2 = await seedRouteCargo("U2", { motorista: "PEDRO", pinned: true });
    const c3 = await seedRouteCargo("U3", { motorista: "JOAO" });
    const op = await seedUser({ email: "op-descend-subir@teste.local" });

    const res = await descendQueueCascade({ sourceLh: "U3", targetLh: "U0", orderedLhs: ["U0", "U1", "U2", "U3"], operatorId: op.id });

    expect(res.payload.reserva).toBe(false);
    expect(res.payload.skippedPinned).toEqual(["U2"]);
    expect(await allocMotorista(c0)).toBe("JOAO");   // assumiu o topo
    expect(await allocMotorista(c1)).toBe("CARLOS");  // desceu
    expect(await allocMotorista(c2)).toBe("PEDRO");   // FIXA intocada
    expect(await allocMotorista(c3)).toBe("ANA");     // ripple preencheu a vaga da origem
    expect(await reservas()).toHaveLength(0);
  });

  it("carga FIXADA no caminho é PULADA (fica no lugar) — não bloqueia", async () => {
    // P1(JOAO) · P2(MARIA, FIXA) · P3(vazio). Solto P1 em P2 (na fixada).
    const c1 = await seedRouteCargo("P1", { motorista: "JOAO" });
    const c2 = await seedRouteCargo("P2", { motorista: "MARIA", pinned: true });
    const c3 = await seedRouteCargo("P3", { motorista: null });
    const op = await seedUser({ email: "op-descend-fixa@teste.local" });

    const res = await descendQueueCascade({ sourceLh: "P1", targetLh: "P2", orderedLhs: ["P1", "P2", "P3"], operatorId: op.id });

    expect(res.payload.skippedPinned).toEqual(["P2"]);
    expect(await allocMotorista(c1)).toBe("");      // origem vaga
    expect(await allocMotorista(c2)).toBe("MARIA");  // FIXA intocada
    expect(await allocMotorista(c3)).toBe("JOAO");   // pulou a fixada e caiu na vaga
    expect(await reservas()).toHaveLength(0);
  });

  it("pré-carregamento (aguardando chegar) PARTICIPA da descida", async () => {
    const c1 = await seedRouteCargo("A1", { motorista: "JOAO" });
    const c2 = await seedRouteCargo("A2", { motorista: "MARIA", status: "AGUARDANDO CHEGAR NO CLIENTE" });
    const c3 = await seedRouteCargo("A3", { motorista: null });
    const op = await seedUser({ email: "op-descend-agc@teste.local" });

    await descendQueueCascade({ sourceLh: "A1", targetLh: "A2", orderedLhs: ["A1", "A2", "A3"], operatorId: op.id });

    expect(await allocMotorista(c1)).toBe("");
    expect(await allocMotorista(c2)).toBe("JOAO");   // A2 editável → recebe
    expect(await allocMotorista(c3)).toBe("MARIA");
  });

  it("rejeita se a ORIGEM está travada por status (já em operação)", async () => {
    const c1 = await seedRouteCargo("T1", { motorista: "JOAO", status: "CARREGADO" });
    await seedRouteCargo("T2", { motorista: null });
    const op = await seedUser({ email: "op-descend-origem-travada@teste.local" });

    await expect(
      descendQueueCascade({ sourceLh: "T1", targetLh: "T2", orderedLhs: ["T1", "T2"], operatorId: op.id }),
    ).rejects.toThrow(/opera|fixada/i);
    expect(await allocMotorista(c1)).toBe("JOAO");
  });

  it("rejeita se a ORIGEM está fixada", async () => {
    const c1 = await seedRouteCargo("PF1", { motorista: "JOAO", pinned: true });
    await seedRouteCargo("PF2", { motorista: null });
    const op = await seedUser({ email: "op-descend-origem-fixa@teste.local" });

    await expect(
      descendQueueCascade({ sourceLh: "PF1", targetLh: "PF2", orderedLhs: ["PF1", "PF2"], operatorId: op.id }),
    ).rejects.toThrow(/fixada|opera/i);
    expect(await allocMotorista(c1)).toBe("JOAO");
  });

  it("rejeita se a fila cruza rotas diferentes", async () => {
    await seedRouteCargo("X1", { motorista: "JOAO" });
    await seedRouteCargo("Y1", { motorista: "MARIA", route: OTHER_ROUTE });
    const op = await seedUser({ email: "op-descend-rota@teste.local" });

    await expect(
      descendQueueCascade({ sourceLh: "X1", targetLh: "Y1", orderedLhs: ["X1", "Y1"], operatorId: op.id }),
    ).rejects.toThrow(/mesma rota/i);
  });

  it("rejeita se a origem ou o destino não estão na ordem enviada", async () => {
    await seedRouteCargo("Z1", { motorista: "JOAO" });
    await seedRouteCargo("Z2", { motorista: null });
    const op = await seedUser({ email: "op-descend-ordem@teste.local" });

    await expect(
      descendQueueCascade({ sourceLh: "NAO-EXISTE", targetLh: "Z2", orderedLhs: ["Z1", "Z2"], operatorId: op.id }),
    ).rejects.toThrow(/origem/i);
    await expect(
      descendQueueCascade({ sourceLh: "Z1", targetLh: "NAO-EXISTE", orderedLhs: ["Z1", "Z2"], operatorId: op.id }),
    ).rejects.toThrow(/destino/i);
  });

  it("carga LANÇADA (lh_manual, sheet_lh NULL) na fila participa da descida (antes dava 404)", async () => {
    // Fila: L1 (LANÇADA, JOAO) topo · L2 (planilha, vazia) base. Solto L1 em L2.
    // Antes do fix, resolver L1 por createSheetLoadId(lh) não achava a lançada →
    // sourceRow undefined → NotFound (404).
    const c1 = await seedLaunchedRouteCargo("LT-DESC-1", { motorista: "JOAO", horario: "10:00:00" });
    const c2 = await seedRouteCargo("L2", { motorista: null, horario: "08:00:00" });
    const op = await seedUser({ email: "op-descend-launched@teste.local" });

    const res = await descendQueueCascade({
      sourceLh: "LT-DESC-1",
      targetLh: "L2",
      orderedLhs: ["LT-DESC-1", "L2"],
      operatorId: op.id,
      correlationId: "c-launched",
    });

    expect(res.payload.ok).toBe(true);
    expect(await allocMotorista(c1)).toBe("");      // origem lançada esvaziou
    expect(await allocMotorista(c2)).toBe("JOAO");   // desceu p/ a planilha vazia
    expect(await reservas()).toHaveLength(0);
  });

  it("descer de novo a mesma origem não duplica reserva (supersede a anterior)", async () => {
    await seedRouteCargo("S1", { motorista: "JOAO" });
    await seedRouteCargo("S2", { motorista: "MARIA" });
    await query(
      `INSERT INTO public.monitor_reservas (motorista, route_key, origin_lh) VALUES ($1, $2, $3)`,
      ["ANTIGO", "Salvador / BA→Feira / BA", "S1"],
    );
    const op = await seedUser({ email: "op-descend-supersede@teste.local" });

    await descendQueueCascade({ sourceLh: "S1", targetLh: "S2", orderedLhs: ["S1", "S2"], operatorId: op.id });

    const active = await reservas();
    expect(active).toHaveLength(1);
    expect(active[0].motorista).toBe("MARIA"); // MARIA sobrou; a antiga foi baixada
  });
});
