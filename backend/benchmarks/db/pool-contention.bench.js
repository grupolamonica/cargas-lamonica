/**
 * pool-contention.bench.js
 *
 * Bottleneck targeted:
 *   #1 — infrastructure/pg/postgres.js: pool max=3 (default)
 *
 * Measures wall-clock time for N concurrent checkout+query+release operations
 * under different pool sizes. Documents how throughput degrades when the pool
 * is smaller than concurrency demand.
 *
 * NOTE: pg-mem serializes queries internally — timings reflect overhead of
 * the Node.js promise queue, not real network latency. On real PostgreSQL,
 * the degradation under pool contention is significantly more pronounced.
 * These results establish the baseline for comparison when CLAIMS_DB_POOL_MAX
 * is raised in production.
 *
 * Does NOT use vitest bench() — uses describe/it with manual timing because
 * we're measuring concurrent wall-clock, not iteration throughput.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { DataType, newDb } from "pg-mem";
import crypto from "node:crypto";
import { measureConcurrent } from "../shared/timer.js";

function createTestPool(maxConnections) {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });
  db.public.none("CREATE TABLE public.ping (id serial PRIMARY KEY)");
  const adapter = db.adapters.createPg();
  return new adapter.Pool({ max: maxConnections });
}

const CONCURRENCY_LEVELS = [3, 5, 10, 20];
const POOL_SIZES = [3, 10];
const ITERATIONS = 3;

describe.sequential("pool contention: max connections vs concurrency", () => {
  for (const poolMax of POOL_SIZES) {
    describe.sequential(`pool.max = ${poolMax}`, () => {
      let pool;

      beforeAll(() => {
        pool = createTestPool(poolMax);
      });

      afterAll(async () => {
        await pool.end();
      });

      for (const concurrency of CONCURRENCY_LEVELS) {
        it(
          `concurrency=${concurrency} | pool.max=${poolMax}`,
          async () => {
            const operation = async () => {
              const client = await pool.connect();
              try {
                await client.query("SELECT 1 AS ok");
              } finally {
                client.release();
              }
            };

            // Warm-up
            await operation();

            const stats = await measureConcurrent(operation, concurrency);

            console.table({
              poolMax,
              concurrency,
              wallMs: stats.wallMs.toFixed(2),
              p50Ms: stats.p50.toFixed(2),
              p95Ms: stats.p95.toFixed(2),
              maxMs: stats.max.toFixed(2),
            });

            // Hard gate: under realistic conditions, p95 per-operation must be
            // < 500ms regardless of pool size. A higher value indicates severe
            // queuing and should block deployment.
            expect(stats.p95).toBeLessThan(500);
          },
          30_000
        );
      }
    });
  }
});

// Baseline: single sequential operations — no contention
describe("pool baseline: sequential (no contention)", () => {
  let pool;

  beforeAll(() => {
    pool = createTestPool(3);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("10 sequential queries on pool.max=3", async () => {
    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
    }
    const elapsed = performance.now() - start;
    console.log(`Sequential baseline: ${elapsed.toFixed(2)}ms for 10 queries`);
    expect(elapsed).toBeLessThan(2_000);
  });
});
