/**
 * batch-vs-loop.bench.js
 *
 * Bottlenecks targeted:
 *   #3 — load-claims/service.js:457  INSERT events in loop (N round-trips)
 *   #4 — load-claims/service.js:416  UPDATE queue_position in loop (N round-trips)
 *
 * Measures: loop vs batch throughput at N=50.
 * Gate: batch variant must be ≥ 3× faster (ops/sec) than loop.
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  resetTestDatabase,
  closeTestDatabase,
  withPgClient,
  query,
  seedLoad,
} from "../shared/bench-harness.js";
import { seedClaimBatch } from "../shared/seed-factories.js";

// ── Shared state ──────────────────────────────────────────────────────────────

const N = 50;
let loadId;
let claimIds;
let driverIds;

async function freshLoad() {
  await resetTestDatabase();
  const load = await seedLoad({ status: "OPEN" });
  loadId = load.id;
  const claims = await seedClaimBatch(query, loadId, N);
  claimIds = claims.map((c) => c.id);
  driverIds = claims.map((c) => c.driverId);
}

// ── EVENT INSERT: loop vs batch ───────────────────────────────────────────────

describe.sequential("event-insert: loop vs VALUES batch (N=50)", () => {
  beforeAll(freshLoad);
  afterAll(closeTestDatabase);

  bench("loop — 1 INSERT per event", async () => {
    await withPgClient(async (client) => {
      for (let i = 0; i < N; i++) {
        await client.query(
          `INSERT INTO public.load_claim_events
             (id, load_id, claim_id, driver_id, event_type, event_payload_json, actor_type, actor_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
          [
            crypto.randomUUID(),
            loadId,
            claimIds[i],
            driverIds[i],
            "BENCH_EVENT",
            "{}",
            "SYSTEM",
            null,
            new Date().toISOString(),
          ]
        );
      }
    });
  });

  bench("batch — single multi-row INSERT", async () => {
    await withPgClient(async (client) => {
      const rows = claimIds.map((claimId, i) => [
        crypto.randomUUID(),
        loadId,
        claimId,
        driverIds[i],
        "BENCH_EVENT",
        "{}",
        "SYSTEM",
        null,
        new Date().toISOString(),
      ]);
      const placeholders = rows
        .map((_, ri) => {
          const b = ri * 9;
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6}::jsonb,$${b+7},$${b+8},$${b+9})`;
        })
        .join(", ");
      await client.query(
        `INSERT INTO public.load_claim_events
           (id, load_id, claim_id, driver_id, event_type, event_payload_json, actor_type, actor_id, created_at)
         VALUES ${placeholders}`,
        rows.flat()
      );
    });
  });
});

// ── QUEUE POSITION UPDATE: loop vs unnest batch ───────────────────────────────

describe.sequential("queue-update: loop vs unnest batch (N=50)", () => {
  beforeAll(freshLoad);
  afterAll(closeTestDatabase);

  bench("loop — 1 UPDATE per claim", async () => {
    await withPgClient(async (client) => {
      for (let i = 0; i < claimIds.length; i++) {
        await client.query(
          `UPDATE public.load_claims SET queue_position = $2 WHERE id = $1`,
          [claimIds[i], i + 1]
        );
      }
    });
  });

  bench("unnest batch — single UPDATE", async () => {
    await withPgClient(async (client) => {
      const positions = claimIds.map((_, i) => i + 1);
      await client.query(
        `UPDATE public.load_claims AS lc
         SET queue_position = data.pos
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::int[]) AS pos) AS data
         WHERE lc.id = data.id`,
        [claimIds, positions]
      );
    });
  });
});
