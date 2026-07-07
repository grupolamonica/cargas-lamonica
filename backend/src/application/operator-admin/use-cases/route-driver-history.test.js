import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { getRouteDriverHistory } = await import("./route-driver-history.js");

// seedCargo não insere sheet_motorista/sheet_cavalo/sheet_carreta/sheet_status —
// setamos direto após o insert (mesmo padrão de update-monitor-allocation.test.js).
async function seedHistCargo({ origem, destino, data, horario, motorista, cavalo = "", carreta = "", status = "FINALIZADO", agenda = null }) {
  const { id } = await seedCargo({ origem, destino, data, horario, status });
  await query(
    `UPDATE public.cargas
     SET sheet_motorista = $2, sheet_cavalo = $3, sheet_carreta = $4, sheet_data_carregamento = $5
     WHERE id = $1`,
    [id, motorista, cavalo, carreta, agenda],
  );
  return id;
}

describe("getRouteDriverHistory", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("retorna só motoristas da mesma rota, não-OPEN, deduplicados com runCount", async () => {
    const ORIGEM = "Salvador / BA";
    const DESTINO = "Simoes Filho / BA";

    // Mesma rota, mesmo motorista → 2 corridas (dedup, runCount=2), mais recente vence.
    await seedHistCargo({
      origem: ORIGEM, destino: DESTINO, data: "2026-04-01", horario: "08:00:00",
      motorista: "Joao da Silva", cavalo: "OLD1111", carreta: "OLD2222", agenda: "2026-04-01 08:00",
    });
    await seedHistCargo({
      origem: ORIGEM, destino: DESTINO, data: "2026-05-10", horario: "09:00:00",
      motorista: "  JOAO da silva ", cavalo: "NEW1111", carreta: "NEW2222", agenda: "2026-05-10 09:00",
    });

    // Mesma rota, outro motorista → runCount=1.
    await seedHistCargo({
      origem: ORIGEM, destino: DESTINO, data: "2026-03-15", horario: "07:00:00",
      motorista: "Maria Souza", cavalo: "MAR1111",
    });

    // Rota diferente → não deve aparecer.
    await seedHistCargo({
      origem: "Feira de Santana / BA", destino: "Salvador / BA", data: "2026-05-20", horario: "10:00:00",
      motorista: "Pedro Alves",
    });

    // Mesma rota mas OPEN → excluído (status <> 'OPEN').
    await seedHistCargo({
      origem: ORIGEM, destino: DESTINO, data: "2026-06-01", horario: "11:00:00",
      motorista: "Carlos Aberto", status: "OPEN",
    });

    const res = await getRouteDriverHistory({ origem: ORIGEM, destino: DESTINO, correlationId: "c1" });

    expect(res.statusCode).toBe(200);
    const drivers = res.payload.drivers;
    const names = drivers.map((d) => d.motorista.toLowerCase().trim()).sort();
    expect(names).toEqual(["joao da silva", "maria souza"]);

    const joao = drivers.find((d) => d.motorista.trim().toLowerCase() === "joao da silva");
    expect(joao.runCount).toBe(2);
    // Mais recente vence (2026-05-10) → cavalo/carreta e agenda da corrida nova.
    expect(joao.cavalo).toBe("NEW1111");
    expect(joao.carreta).toBe("NEW2222");
    expect(joao.ultimaAgendaLabel).toBe("2026-05-10 09:00");

    const maria = drivers.find((d) => d.motorista.trim().toLowerCase() === "maria souza");
    expect(maria.runCount).toBe(1);

    // Pedro (outra rota) e Carlos (OPEN) ausentes.
    expect(drivers.find((d) => d.motorista.includes("Pedro"))).toBeUndefined();
    expect(drivers.find((d) => d.motorista.includes("Carlos"))).toBeUndefined();
  });

  it("rota sem histórico → lista vazia", async () => {
    const res = await getRouteDriverHistory({ origem: "Recife / PE", destino: "Olinda / PE", correlationId: "c2" });
    expect(res.statusCode).toBe(200);
    expect(res.payload.drivers).toEqual([]);
  });
});
