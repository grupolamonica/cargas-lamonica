/**
 * DC-295 — agregação "cargas com/sem motorista por dia de carregamento" (SQL real no pg-mem).
 *
 * Testa `queryLoadAllocationByDay` isolada (recebe um client do harness), para não depender
 * das demais queries do fetchDriverFlowMetrics (algumas usam EXTRACT ... AT TIME ZONE, que o
 * pg-mem pode não cobrir). Janela FIXA no futuro → determinístico, sem depender do relógio.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { queryLoadAllocationByDay } from "./driver-flow-metrics.js";
import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  withPgClient,
} from "../../application/operator-admin/test-harness.js";

const addDays = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

// seedCargo não seta alloc_motorista/sheet_motorista → preenche por UPDATE (padrão do harness).
async function seedComMotorista(over, coluna) {
  const { id } = await seedCargo(over);
  await query(`UPDATE public.cargas SET ${coluna} = $1 WHERE id = $2`, ["MOTORISTA TESTE", id]);
  return id;
}

const run = (from, to) => withPgClient((client) => queryLoadAllocationByDay(client, from, to));

describe("DC-295 — queryLoadAllocationByDay (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("agrega total/com/sem por dia; 'com' = alloc OU sheet motorista; ignora fora-da-janela/rascunho/cancelada", async () => {
    const D0 = "2030-03-10";
    const D1 = "2030-03-11";
    const FORA = "2030-03-18"; // fora de [D0, D0+7)

    await seedComMotorista({ data: D0 }, "alloc_motorista"); // D0 com (alloc — decisão do operador)
    await seedCargo({ data: D0 }); //                          D0 sem
    await seedComMotorista({ data: D0 }, "sheet_motorista"); // D0 com (planilha)
    await seedCargo({ data: D1 }); //                          D1 sem
    await seedCargo({ data: FORA }); //                        fora da janela → ignora
    await seedCargo({ data: D0, status: "DRAFT" }); //         rascunho → ignora
    await seedCargo({ data: D0, status: "CANCELLED" }); //     cancelada → ignora

    const la = await run(D0, addDays(D0, 7));

    expect(la.from).toBe(D0);
    expect(la.toExclusive).toBe(addDays(D0, 7));
    expect(la.totals).toEqual({ total: 4, com: 2, sem: 2 });

    const porDia = Object.fromEntries(la.dias.map((d) => [d.dia, d]));
    expect(porDia[D0]).toMatchObject({ total: 3, com: 2, sem: 1 });
    expect(porDia[D1]).toMatchObject({ total: 1, com: 0, sem: 1 });
    expect(porDia[FORA]).toBeUndefined();
    // invariante com + sem = total, por dia
    for (const d of la.dias) expect(d.com + d.sem).toBe(d.total);
  });

  it("sem cargas na janela → totals zerados e dias vazio", async () => {
    await seedCargo({ data: "2030-03-10" });
    const la = await run("2031-01-01", "2031-01-08");
    expect(la.totals).toEqual({ total: 0, com: 0, sem: 0 });
    expect(la.dias).toEqual([]);
  });
});
