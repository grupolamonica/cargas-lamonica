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

// Write-back pra planilha (espelho) — mockado p/ capturar o que é espelhado.
const { writeSpy } = vi.hoisted(() => ({ writeSpy: vi.fn(async () => {}) }));
vi.mock("../../google-sheets/sheet-writeback.js", () => ({ writeAllocationsToSheet: writeSpy }));

const { assignReservaToCarga } = await import("./assign-reserva-to-carga.js");

const ROUTE = { origem: "Salvador / BA", destino: "Feira / BA" };

async function seedReserva({ motorista, cavalo, carreta } = {}) {
  const { rows } = await query(
    `INSERT INTO public.monitor_reservas (motorista, cavalo, carreta, origem, destino, route_key, origin_lh)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [motorista ?? "STANDBY X", cavalo ?? "STB1A11", carreta ?? "STB2B22", ROUTE.origem, ROUTE.destino, `${ROUTE.origem}→${ROUTE.destino}`, "OLD-CANCEL"],
  );
  return rows[0].id;
}

const allocOf = async (id) =>
  (await query(`SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_source FROM public.cargas WHERE id = $1`, [id])).rows[0];
const reservaActive = async (id) =>
  (await query(`SELECT active FROM public.monitor_reservas WHERE id = $1`, [id])).rows[0].active;

describe("assignReservaToCarga", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("puxa o standby para uma carga da PLANILHA e baixa a reserva (+ write-back)", async () => {
    const id = createSheetLoadId("LH-RSV");
    await seedCargo({ id, sheet_lh: "LH-RSV", status: "OPEN", origem: ROUTE.origem, destino: ROUTE.destino });
    const reservaId = await seedReserva({ motorista: "JOAO STANDBY" });
    const operator = await seedUser({ email: "op-rsv-sheet@teste.local" });

    const res = await assignReservaToCarga({ reservaId, targetLh: "LH-RSV", operatorId: operator.id, correlationId: "corr-rsv-sheet" });

    expect(res.statusCode).toBe(200);
    const alloc = await allocOf(id);
    expect(alloc.alloc_motorista).toBe("JOAO STANDBY");
    expect(alloc.alloc_source).toBe("operator");
    expect(await reservaActive(reservaId)).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1); // planilha → espelha
  });

  it("puxa o standby para uma carga do SISTEMA (lançada, lh_manual) resolvida por LH — sem write-back", async () => {
    // Antes do fix, resolver o destino por createSheetLoadId(targetLh) não achava a
    // carga lançada → "Carga de destino não encontrada".
    const { id } = await seedCargo({ status: "OPEN", origem: ROUTE.origem, destino: ROUTE.destino });
    await query(`UPDATE public.cargas SET lh_manual = 'LT-RSV-SYS' WHERE id = $1`, [id]);
    const reservaId = await seedReserva({ motorista: "MARIA STANDBY", cavalo: "MMM1M11", carreta: "MMM2M22" });
    const operator = await seedUser({ email: "op-rsv-sys@teste.local" });

    const res = await assignReservaToCarga({ reservaId, targetLh: "LT-RSV-SYS", operatorId: operator.id, correlationId: "corr-rsv-sys" });

    expect(res.statusCode).toBe(200);
    const alloc = await allocOf(id);
    expect(alloc.alloc_motorista).toBe("MARIA STANDBY");
    expect(alloc.alloc_cavalo).toBe("MMM1M11");
    expect(await reservaActive(reservaId)).toBe(false);
    // Carga do sistema não tem linha própria na planilha → NÃO faz write-back.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("lança NotFoundError quando o LH de destino não tem carga", async () => {
    const reservaId = await seedReserva({});
    const operator = await seedUser({ email: "op-rsv-404@teste.local" });
    await expect(
      assignReservaToCarga({ reservaId, targetLh: "LH-INEXISTENTE", operatorId: operator.id, correlationId: "corr-rsv-404" }),
    ).rejects.toThrow();
  });
});
