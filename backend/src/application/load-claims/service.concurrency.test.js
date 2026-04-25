import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM_STATUS, LOAD_STATUS } from "../../domain/load-claims/constants.js";

vi.mock("../../infrastructure/pg/postgres.js", async () => {
  const harness = await import("./test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("./logging.js", () => ({
  logLoadClaimEvent: vi.fn(),
}));

let harness;
let service;

async function runConcurrentClaimRace(participantCount) {
  const { id: loadId } = await harness.seedLoad();
  const drivers = await Promise.all(
    harness.buildDriverBatch(participantCount).map((driver) =>
      harness.seedDriverProfile({
        email: driver.email,
        full_name: driver.full_name,
      }),
    ),
  );

  const results = await Promise.all(
    drivers.map((driver, index) =>
      service.createLoadClaim({
        loadId,
        driverId: driver.userId,
        idempotencyKey: harness.buildIdempotencyKey(`race-${participantCount}-${index}`),
        correlationId: `corr-race-${participantCount}-${index}`,
      }),
    ),
  );

  const load = await harness.getLoad(loadId);
  const claims = await harness.getClaimsByLoad(loadId);
  const reservingClaims = claims.filter((claim) => harness.statusSets.reserving.has(claim.status));
  const waitlistedClaims = claims.filter((claim) => claim.status === CLAIM_STATUS.WAITLISTED);

  expect(results.filter((result) => result.payload.outcome === "RESERVED")).toHaveLength(1);
  expect(results.filter((result) => result.payload.outcome === "WAITLISTED")).toHaveLength(participantCount - 1);
  expect(load.status).toBe(LOAD_STATUS.RESERVED);
  expect(reservingClaims).toHaveLength(1);
  expect(waitlistedClaims).toHaveLength(participantCount - 1);
  expect(waitlistedClaims.map((claim) => claim.queue_position)).toEqual(
    Array.from({ length: participantCount - 1 }, (_, index) => index + 1),
  );

  const winner = reservingClaims[0];

  await service.confirmLoadClaim({
    loadId,
    claimId: winner.id,
    driverId: winner.driver_id,
    idempotencyKey: harness.buildIdempotencyKey(`confirm-${participantCount}`),
    correlationId: `corr-confirm-${participantCount}`,
  });

  const bookedLoad = await harness.getLoad(loadId);
  const finalClaims = await harness.getClaimsByLoad(loadId);

  expect(bookedLoad.status).toBe(LOAD_STATUS.BOOKED);
  expect(finalClaims.filter((claim) => claim.status === CLAIM_STATUS.CONFIRMED)).toHaveLength(1);
  expect(finalClaims.filter((claim) => claim.status === CLAIM_STATUS.WAITLISTED)).toHaveLength(0);
}

describe.sequential("load-claim concurrency and resilience", () => {
  beforeAll(async () => {
    harness = await import("./test-harness.js");
    service = await import("./service.js");
  });

  beforeEach(async () => {
    process.env.CLAIM_V2_ENABLED = "true";
    process.env.WAITLIST_ENABLED = "true";
    process.env.RESERVATION_TTL_SECONDS = "120";
    process.env.CLAIM_IDEMPOTENCY_TTL_SECONDS = "86400";
    process.env.CLAIM_MAINTENANCE_BATCH_SIZE = "25";
    await harness.resetTestDatabase();
  });

  afterAll(async () => {
    await harness.closeTestDatabase();
  });

  it("keeps a single active reservation under 10 simultaneous requests", async () => {
    await runConcurrentClaimRace(10);
  }, 15_000);

  it("keeps a single active reservation under 50 simultaneous requests", async () => {
    await runConcurrentClaimRace(50);
  }, 30_000);

  it("keeps a single active reservation under 100 simultaneous requests", async () => {
    await runConcurrentClaimRace(100);
  }, 45_000);

  it("replays the same logical response for concurrent retries with the same idempotency key", async () => {
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();
    const idempotencyKey = harness.buildIdempotencyKey("parallel-retry");

    const [first, second] = await Promise.all([
      service.createLoadClaim({
        loadId,
        driverId,
        idempotencyKey,
        correlationId: "corr-parallel-retry-1",
      }),
      service.createLoadClaim({
        loadId,
        driverId,
        idempotencyKey,
        correlationId: "corr-parallel-retry-2",
      }),
    ]);

    const claims = await harness.getClaimsByLoad(loadId);
    const events = await harness.getEventsByLoad(loadId);

    expect(first.payload.outcome).toBe("RESERVED");
    expect(second.payload.outcome).toBe("RESERVED");
    expect(second.payload.meta.idempotencyReused).toBe(true);
    expect(claims).toHaveLength(1);
    expect(events.filter((event) => event.event_type === "IDEMPOTENCY_REPLAY")).toHaveLength(1);
  });

  it("remains idempotent when the maintenance worker is triggered in parallel", async () => {
    const { id: loadId } = await harness.seedLoad();
    const firstDriver = await harness.seedDriverProfile({ email: "worker-first@test.local" });
    const secondDriver = await harness.seedDriverProfile({ email: "worker-second@test.local" });

    await service.createLoadClaim({
      loadId,
      driverId: firstDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("worker-first"),
      correlationId: "corr-worker-first",
    });

    await service.createLoadClaim({
      loadId,
      driverId: secondDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("worker-second"),
      correlationId: "corr-worker-second",
    });

    await harness.expireReservation(loadId);

    const [runA, runB] = await Promise.all([
      service.processExpiredLoadClaims({
        batchSize: 10,
        correlationId: "corr-worker-a",
      }),
      service.processExpiredLoadClaims({
        batchSize: 10,
        correlationId: "corr-worker-b",
      }),
    ]);

    const load = await harness.getLoad(loadId);
    const claims = await harness.getClaimsByLoad(loadId);

    expect(runA.processedCount + runB.processedCount).toBe(1);
    expect(load.status).toBe(LOAD_STATUS.RESERVED);
    expect(claims.filter((claim) => claim.status === CLAIM_STATUS.PROMOTED)).toHaveLength(1);
    expect(claims.filter((claim) => harness.statusSets.reserving.has(claim.status))).toHaveLength(1);
  });
});
