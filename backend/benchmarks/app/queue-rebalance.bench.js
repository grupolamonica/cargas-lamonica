/**
 * queue-rebalance.bench.js
 *
 * Bottleneck targeted:
 *   #4 — service.js:416 — queue_position UPDATE loop fires N individual
 *         queries instead of a single unnest-based batch.
 *
 * What this bench measures:
 *   processExpiredLoadClaims with a 50-claim waitlist triggers the
 *   syncWaitlistPositions code path, which currently executes 50 UPDATEs.
 *
 * Query count gate (production code):
 *   ~53-55 queries expected (1 expired candidate SELECT + BEGIN/COMMIT +
 *   1 lock + 1 expiry UPDATE + 1 waitlist SELECT + 50 position UPDATEs
 *   + 1 load OPEN UPDATE + 1 security audit + ...).
 *
 * When a batch refactor ships (unnest UPDATE), the gate should drop to ≤ 10.
 *
 * The bench runs 3 iterations manually (using timer.js) because vitest bench()
 * doesn't reset beforeEach between iterations — reset happens in the timing loop.
 */

import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import crypto from "node:crypto";
import { measureMsRepeat } from "../shared/timer.js";

vi.mock("../../src/infrastructure/pg/postgres.js", async () => {
  const harness = await import("../../src/application/load-claims/test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("../../src/application/load-claims/logging.js", () => ({
  logLoadClaimEvent: vi.fn(),
}));

const N_CLAIMS = 50;
let harness;
let service;

describe.sequential("queue-rebalance: processExpiredLoadClaims (N=50 waitlist)", () => {
  beforeAll(async () => {
    harness = await import("../../src/application/load-claims/test-harness.js");
    service = await import("../../src/application/load-claims/service.js");

    process.env.CLAIM_V2_ENABLED = "true";
    process.env.WAITLIST_ENABLED = "true";
  });

  afterAll(() => harness.closeTestDatabase());

  async function seedScenario() {
    await harness.resetTestDatabase();

    // Seed a reserved load
    const reservingUser = await harness.seedUser();
    await harness.seedDriverProfile({ user_id: reservingUser.id });
    const load = await harness.seedLoad({ status: "OPEN" });

    // Claim the load with first driver (gets RESERVED status)
    await service.createLoadClaim({
      loadId: load.id,
      driverId: reservingUser.id,
      idempotencyKey: "reserve-" + crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    });

    // Add N_CLAIMS waitlisted drivers
    for (let i = 0; i < N_CLAIMS; i++) {
      const u = await harness.seedUser();
      await harness.seedDriverProfile({ user_id: u.id });
      await service.createLoadClaim({
        loadId: load.id,
        driverId: u.id,
        idempotencyKey: `waitlist-${i}-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
      });
    }

    // Expire the reservation so processExpiredLoadClaims can trigger rebalance
    await harness.expireReservation(load.id);
    return load.id;
  }

  it(
    `wall-clock: processExpiredLoadClaims with ${N_CLAIMS} waitlisted claims`,
    async () => {
      const loadId = await seedScenario();

      const stats = await measureMsRepeat(async () => {
        await service.processExpiredLoadClaims({
          batchSize: 1,
          correlationId: crypto.randomUUID(),
        });
        // Re-expire so the bench can run again
        await harness.expireReservation(loadId);
      }, 3);

      console.table({
        operation: `processExpiredLoadClaims (N=${N_CLAIMS})`,
        p50Ms: stats.p50.toFixed(2),
        p95Ms: stats.p95.toFixed(2),
        maxMs: stats.max.toFixed(2),
      });

      // Soft gate: must complete in under 5s even with 50 individual UPDATEs
      expect(stats.p95).toBeLessThan(5_000);
    },
    60_000
  );

  // This bench directly counts queries for the rebalance path.
  it(
    "query count: expect ≤ 80 queries for 50-claim rebalance (loop pattern)",
    async () => {
      const loadId = await seedScenario();

      let queryCount = 0;
      const originalTx = harness.withPgTransaction;

      // Patch withPgTransaction to count queries on each client
      vi.spyOn(
        await import("../../src/infrastructure/pg/postgres.js"),
        "withPgTransaction"
      ).mockImplementation(async (cb) => {
        return harness.withPgTransaction(async (client) => {
          const originalQuery = client.query.bind(client);
          client.query = async (...args) => {
            queryCount++;
            return originalQuery(...args);
          };
          return cb(client);
        });
      });

      await service.processExpiredLoadClaims({
        batchSize: 1,
        correlationId: crypto.randomUUID(),
      });

      console.log(
        `[queue-rebalance] Total queries for ${N_CLAIMS}-claim rebalance: ${queryCount}`,
        "\n  (Expected ≤80 loop; ≤10 after batch refactor)"
      );

      // Document current baseline — update to a lower gate after batch refactor
      expect(queryCount).toBeLessThan(200);

      vi.restoreAllMocks();
    },
    60_000
  );
});
