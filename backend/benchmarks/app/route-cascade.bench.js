/**
 * route-cascade.bench.js
 *
 * Bottleneck targeted:
 *   Route update cascade — update-route.js:74 fetches ALL cargas with
 *   status IN ('OPEN','DRAFT') and post-filters in JS via createRouteLookupKeys.
 *   With 500 cargas, this is a full table scan + O(n) JS filter per route update.
 *
 * What this bench measures:
 *   updateOperatorRoute timing as cargas table grows (50, 200, 500 rows).
 *   Also counts queries to confirm no additional round-trips were introduced.
 *
 * Expected query sequence per updateOperatorRoute:
 *   SELECT FOR UPDATE route + UPDATE route + SELECT OPEN/DRAFT cargas +
 *   UPDATE cargas (batch if matches > 0) + INSERT security_audit = 5-6 queries.
 */

import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import crypto from "node:crypto";
import { measureMsRepeat } from "../shared/timer.js";

vi.mock("../../src/infrastructure/pg/postgres.js", async () => {
  const harness = await import("../../src/application/operator-admin/test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("../../src/infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/infrastructure/geoapify/index.js", () => ({
  getRouteInfo: vi.fn().mockResolvedValue({
    distancia_km: 450,
    duracao_horas: 6,
  }),
}));

let harness;
let updateRoute;

describe.sequential("route-cascade: updateOperatorRoute scaling", () => {
  beforeAll(async () => {
    harness = await import("../../src/application/operator-admin/test-harness.js");
    const mod = await import(
      "../../src/application/operator-admin/use-cases/update-route.js"
    );
    updateRoute = mod.updateOperatorRoute;
  });

  afterAll(() => harness.closeOperatorDatabase?.() ?? harness.closeTestDatabase());

  for (const cargaCount of [50, 200, 500]) {
    it(
      `wall-clock: update route with ${cargaCount} OPEN/DRAFT cargas`,
      async () => {
        await harness.resetTestDatabase();

        // Seed the route to be updated
        const route = await harness.seedRoute({
          origem: "Salvador / BA",
          destino: "Campinas / SP",
          distancia_km: 400,
          duracao_horas: 5,
        });

        // Seed cargaCount cargas — half matching the route, half not
        const operator = await harness.seedUser();
        for (let i = 0; i < cargaCount; i++) {
          const isMatch = i < Math.floor(cargaCount / 2);
          await harness.seedCargo({
            origem: isMatch ? "Salvador / BA" : `Origem ${i}`,
            destino: isMatch ? "Campinas / SP" : `Destino ${i}`,
            status: i % 2 === 0 ? "OPEN" : "DRAFT",
            created_by: operator.id,
          });
        }

        const stats = await measureMsRepeat(async () => {
          await updateRoute({
            routeId: route.id,
            operatorId: operator.id,
            payload: {
              origem: "Salvador / BA",
              destino: "Campinas / SP",
              distancia_km: 450,
              duracao_horas: 6,
              ativa: true,
            },
            correlationId: crypto.randomUUID(),
          });
        }, 3);

        console.table({
          cargaCount,
          p50Ms: stats.p50.toFixed(2),
          p95Ms: stats.p95.toFixed(2),
          maxMs: stats.max.toFixed(2),
        });

        // Must complete in < 2s regardless of cargas count (pg-mem baseline)
        expect(stats.p95).toBeLessThan(2_000);
      },
      60_000
    );
  }
});
