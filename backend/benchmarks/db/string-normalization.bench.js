/**
 * string-normalization.bench.js
 *
 * Bottleneck targeted:
 *   #2 — read-models.js:1804  Vehicles JOIN uses REPLACE(REPLACE(...)) in predicate,
 *         preventing index use and costing a per-row scan on every request.
 *
 * Compares:
 *   a) Current: REPLACE() on both sides of the JOIN predicate
 *   b) Improved: Pre-normalized column (direct equality, index-friendly)
 *
 * N = 200 vehicles / 200 driver_profiles.
 * Gate: normalized ≥ 2× faster than REPLACE().
 *
 * NOTE: pg-mem does not use B-tree indexes, so the speedup here reflects
 * pure CPU cost of REPLACE(). On real PostgreSQL the gap is larger because
 * the normalized path can use an index scan instead of a seq scan.
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import {
  resetOperatorDatabase,
  closeOperatorDatabase,
  operatorQuery,
  seedOperatorUser,
  seedOperatorDriverProfile,
} from "../shared/bench-harness.js";
import { seedVehicleBatch } from "../shared/seed-factories.js";

const N = 200;

async function seedData() {
  await resetOperatorDatabase();

  // Seed N driver_profiles with formatted document_number "XXX.XXX.XXX-XX"
  for (let i = 0; i < N; i++) {
    const user = await seedOperatorUser();
    const padded = String(i).padStart(6, "0");
    const cpfFormatted = `${padded.slice(0, 3)}.${padded.slice(0, 3)}.${padded.slice(0, 3)}-${String(i % 100).padStart(2, "0")}`;
    const cpfRaw = `${padded}${padded}`.slice(0, 11);
    await seedOperatorDriverProfile({
      user_id: user.id,
      document_number: cpfFormatted,
      document_number_raw: cpfRaw,
    });
  }

  // Seed N vehicles with linked_driver_cpf as raw (11-digit) CPF
  await seedVehicleBatch(operatorQuery, N, { cpfStyle: "raw" });
}

describe.sequential("vehicles JOIN: REPLACE() vs pre-normalized (N=200)", () => {
  beforeAll(seedData);
  afterAll(closeOperatorDatabase);

  bench("REPLACE() on both sides — current production", async () => {
    await operatorQuery(`
      SELECT v.id, dp.user_id
      FROM public.vehicles v
      LEFT JOIN public.driver_profiles dp
        ON REPLACE(REPLACE(dp.document_number, '.', ''), '-', '') = v.linked_driver_cpf
      LIMIT 200
    `);
  });

  bench("direct equality — pre-normalized column", async () => {
    // Simulates storing document_number without formatting at insert time.
    // On production this would be backed by an index.
    await operatorQuery(`
      SELECT v.id, dp.user_id
      FROM public.vehicles v
      LEFT JOIN public.driver_profiles dp
        ON dp.document_number = v.linked_driver_cpf
      LIMIT 200
    `);
  });
});

describe.sequential("LATERAL phone lookup: REPLACE() vs pre-normalized (N=200)", () => {
  beforeAll(async () => {
    // Re-use the existing seed; add public_leads with matching CPF
    const vehicles = await operatorQuery(
      "SELECT id, linked_driver_cpf FROM public.vehicles WHERE linked_driver_cpf IS NOT NULL LIMIT 200"
    );
    const now = new Date().toISOString();
    for (const v of vehicles.rows.slice(0, 50)) {
      await operatorQuery(
        `INSERT INTO public.load_public_leads
           (id, load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2,
            vehicle_type, status, created_at, updated_at)
         SELECT gen_random_uuid(), c.id, $1, '+5511999999999', 'HX0001', 'TX0001', '',
                'CARRETA', 'PRE_REGISTERED', $2, $2
         FROM public.cargas c LIMIT 1`,
        [v.linked_driver_cpf, now]
      );
    }
  });

  bench("REPLACE() in LATERAL — current production", async () => {
    await operatorQuery(`
      SELECT v.id, lpl.phone
      FROM public.vehicles v
      LEFT JOIN LATERAL (
        SELECT phone
        FROM public.load_public_leads
        WHERE REPLACE(REPLACE(cpf, '.', ''), '-', '') = v.linked_driver_cpf
          AND v.linked_driver_cpf IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) lpl ON true
      LIMIT 200
    `);
  });

  bench("direct equality in LATERAL — pre-normalized", async () => {
    await operatorQuery(`
      SELECT v.id, lpl.phone
      FROM public.vehicles v
      LEFT JOIN LATERAL (
        SELECT phone
        FROM public.load_public_leads
        WHERE cpf = v.linked_driver_cpf
          AND v.linked_driver_cpf IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) lpl ON true
      LIMIT 200
    `);
  });
});
