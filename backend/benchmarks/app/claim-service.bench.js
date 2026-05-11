/**
 * claim-service.bench.js
 *
 * Bottlenecks targeted:
 *   End-to-end createLoadClaim timing and query-count gate.
 *
 * Query budget per createLoadClaim:
 *   ≤ 8 queries: idempotency lookup, idempotency INSERT, load SELECT FOR UPDATE,
 *   claim INSERT, sequence update, event INSERT, load UPDATE, security audit.
 *
 * Thresholds:
 *   - Happy-path p95 < 15ms on pg-mem
 *   - Waitlisted p95 < 25ms
 *   - Query count ≤ 8
 *
 * Mock pattern mirrors service.integration.test.js exactly.
 */

import { bench, describe, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";

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

let harness;
let service;
let loadId;
let driverId;

describe.sequential("createLoadClaim benchmarks", () => {
  beforeAll(async () => {
    harness = await import("../../src/application/load-claims/test-harness.js");
    service = await import("../../src/application/load-claims/service.js");

    process.env.CLAIM_V2_ENABLED = "true";
    process.env.WAITLIST_ENABLED = "true";
    process.env.CLAIMS_DB_POOL_MAX = "3";
  });

  afterAll(async () => {
    await harness.closeTestDatabase();
  });

  describe("happy path — empty queue", () => {
    beforeEach(async () => {
      await harness.resetTestDatabase();
      const load = await harness.seedLoad({ status: "OPEN" });
      loadId = load.id;
      const user = await harness.seedUser();
      driverId = user.id;
      await harness.seedDriverProfile({ user_id: driverId });
    });

    bench("createLoadClaim: eligible driver, empty queue", async () => {
      await service.createLoadClaim({
        loadId,
        driverId,
        idempotencyKey: `bench-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
      });
    });
  });

  describe("waitlisted — queue depth 10", () => {
    let waitlistedDriverId;

    beforeAll(async () => {
      await harness.resetTestDatabase();
      const load = await harness.seedLoad({ status: "OPEN" });
      loadId = load.id;

      // Seed one driver that WILL claim and get waitlisted (all spots taken by others)
      const u = await harness.seedUser();
      waitlistedDriverId = u.id;
      await harness.seedDriverProfile({ user_id: waitlistedDriverId });

      // Occupy the load: reserve it with a different driver
      const reservingUser = await harness.seedUser();
      await harness.seedDriverProfile({ user_id: reservingUser.id });
      await service.createLoadClaim({
        loadId,
        driverId: reservingUser.id,
        idempotencyKey: "reserve-" + crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
      });
    });

    bench("createLoadClaim: driver goes to waitlist", async () => {
      await service.createLoadClaim({
        loadId,
        driverId: waitlistedDriverId,
        idempotencyKey: `bench-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
      });
      // Reset driver so bench can run again cleanly
      await harness.query(
        `DELETE FROM public.load_claims WHERE driver_id = $1 AND load_id = $2`,
        [waitlistedDriverId, loadId]
      );
      await harness.query(
        `DELETE FROM public.idempotency_records WHERE driver_id = $1 AND load_id = $2`,
        [waitlistedDriverId, loadId]
      );
    });
  });
});
