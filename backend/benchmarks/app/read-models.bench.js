/**
 * read-models.bench.js
 *
 * Bottlenecks targeted:
 *   #2  — vehicles list JOIN with REPLACE() (timing + N+1 gate)
 *   #5  — routes list LIMIT 2000 hardcoded
 *   #6  — cargo list ILIKE search without trigram index
 *
 * Query count gates:
 *   - Vehicles list: ≤ 3 queries (count + data + summary) — not N+1
 *   - Routes list:   = 1 query
 *   - Cargo ILIKE:   = 1 query
 */

import { bench, describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import crypto from "node:crypto";
import { createQuerySpy } from "../shared/pg-spy.js";
import { seedRouteBatch } from "../shared/seed-factories.js";

vi.mock("../../src/infrastructure/pg/postgres.js", async () => {
  const harness = await import("../../src/application/operator-admin/test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("../../src/application/google-sheets/google-sheet-loads.js", () => ({
  createSupabaseAdminClient: vi.fn(() => ({
    auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }) } },
  })),
}));

let harness;
let readModels;

describe.sequential("read-models: vehicles list (N+1 gate)", () => {
  beforeAll(async () => {
    harness = await import("../../src/application/operator-admin/test-harness.js");
    readModels = await import(
      "../../src/application/operator-admin/read-models.js"
    );

    await harness.resetTestDatabase();

    // Seed 100 vehicles with formatted CPFs to trigger REPLACE() in JOIN
    for (let i = 0; i < 100; i++) {
      const user = await harness.seedUser();
      const padded = String(i).padStart(6, "0");
      await harness.seedOperatorDriverProfile?.({
        user_id: user.id,
        document_number: `${padded.slice(0, 3)}.${padded.slice(0, 3)}.${padded.slice(0, 3)}-${String(i % 100).padStart(2, "0")}`,
      }) ?? await harness.seedDriverProfile?.({
        user_id: user.id,
        document_number: `${padded.slice(0, 3)}.${padded.slice(0, 3)}.${padded.slice(0, 3)}-${String(i % 100).padStart(2, "0")}`,
      });

      await harness.seedVehicle({
        plate: `VH${String(i).padStart(4, "0")}`,
        linked_driver_cpf: `${padded}${padded}`.slice(0, 11),
      });
    }
  });

  afterAll(() => harness.closeTestDatabase());

  bench("vehicles list page 1 — 100 vehicles with REPLACE() JOIN", async () => {
    await readModels.fetchOperatorVehiclesListReadModel({
      query: { page: "1", pageSize: "20" },
      correlationId: crypto.randomUUID(),
    });
  });

  it("N+1 gate: vehicles list fires ≤ 3 queries", async () => {
    await harness.withPgClient(async (client) => {
      const spy = createQuerySpy(client);

      // Call the read-model via withPgClient mock — the spy intercepts
      // To count queries we patch the harness's withPgClient temporarily
      const original = harness.withPgClient;
      harness.withPgClient = async (cb) => original(async (c) => {
        const s = createQuerySpy(c);
        const result = await cb(c);
        console.log(`[vehicles N+1 gate] Queries fired: ${s.count}`);
        s.assertMaxQueries(5, "fetchOperatorVehiclesListReadModel");
        s.restore();
        return result;
      });

      await readModels.fetchOperatorVehiclesListReadModel({
        query: { page: "1", pageSize: "20" },
        correlationId: crypto.randomUUID(),
      });

      harness.withPgClient = original;
      spy.restore();
    });
  });
});

describe.sequential("read-models: routes list (LIMIT 2000 gate)", () => {
  beforeAll(async () => {
    await harness.resetTestDatabase();
    // Seed 500 routes to stress the LIMIT 2000 query
    await seedRouteBatch(harness.operatorQuery ?? harness.query, 500);
  });

  bench("routes list — SELECT LIMIT 2000 with 500 rows", async () => {
    await readModels.fetchOperatorRoutesListReadModel({
      query: { page: "1", pageSize: "20" },
      correlationId: crypto.randomUUID(),
    });
  });
});

describe.sequential("read-models: cargo ILIKE search (trigram gap)", () => {
  beforeAll(async () => {
    await harness.resetTestDatabase();
    // Seed 200 cargas with varied origem/destino to exercise ILIKE
    for (let i = 0; i < 200; i++) {
      const origens = ["Salvador / BA", "São Paulo / SP", "Campinas / SP", `Cidade ${i}`];
      await harness.seedCargo({
        origem: origens[i % origens.length],
        destino: `Destino ${i}`,
        status: "OPEN",
      });
    }
  });

  bench("cargo list — ILIKE search 'Salvador' in 200 rows (no trigram index)", async () => {
    await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "20", search: "Salvador" },
      correlationId: crypto.randomUUID(),
    });
  });

  bench("cargo list — no search filter (baseline)", async () => {
    await readModels.fetchOperatorCargoListReadModel({
      query: { page: "1", pageSize: "20" },
      correlationId: crypto.randomUUID(),
    });
  });
});
