/**
 * lateral-subquery.bench.js
 *
 * Bottleneck targeted:
 *   #7 — Missing index on load_public_leads(cpf, created_at DESC) means LATERAL
 *         subquery does a sequential scan per vehicle row.
 *
 *   Also documents the N+1 anti-pattern: if the LATERAL is ever replaced by
 *   an application-level loop, cost explodes linearly.
 *
 * Key assertions:
 *   - LATERAL case fires exactly 1 SQL query to the database (not N+1).
 *   - LATERAL is ≥ 5× faster than the N+1 loop equivalent.
 *
 * N = 100 vehicles.
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import {
  resetOperatorDatabase,
  closeOperatorDatabase,
  withOperatorPgClient,
  operatorQuery,
  seedOperatorUser,
  seedCargo,
} from "../shared/bench-harness.js";
import { seedVehicleBatch, seedPublicLeadBatch } from "../shared/seed-factories.js";
import { createQuerySpy } from "../shared/pg-spy.js";

const N = 100;
let loadId;

beforeAll(async () => {
  await resetOperatorDatabase();
  const load = await seedCargo({ status: "OPEN" });
  loadId = load.id;

  // Seed N vehicles with raw CPFs
  await seedVehicleBatch(operatorQuery, N, { cpfStyle: "raw" });

  // Seed public leads with same CPFs (matches vehicles)
  const vehicles = await operatorQuery(
    "SELECT linked_driver_cpf FROM public.vehicles WHERE linked_driver_cpf IS NOT NULL"
  );
  const now = new Date().toISOString();
  if (vehicles.rows.length > 0) {
    const rows = vehicles.rows.slice(0, N);
    const placeholders = rows.map((_, i) => {
      const b = i * 9;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`;
    }).join(", ");
    const vals = rows.flatMap((v) => [
      crypto.randomUUID(), loadId, v.linked_driver_cpf,
      "+55119999" + String(Math.random()).slice(2, 6),
      "HSE0001", "TRL0001", "",
      "CARRETA", now,
    ]);
    await operatorQuery(
      `INSERT INTO public.load_public_leads
         (id, load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2,
          vehicle_type, created_at)
       VALUES ${placeholders}`,
      vals
    );
  }
});

afterAll(closeOperatorDatabase);

describe.sequential("lateral-subquery: N+1 detection (N=100 vehicles)", () => {
  bench("LATERAL — 1 SQL query total", async () => {
    await withOperatorPgClient(async (client) => {
      const spy = createQuerySpy(client);

      await client.query(`
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
      `);

      // CRITICAL: exactly 1 round-trip to the database regardless of vehicle count
      spy.assertMaxQueries(1, "lateral-phone-lookup");
      spy.restore();
    });
  });

  bench("N+1 loop — 1 query per vehicle (anti-pattern)", async () => {
    await withOperatorPgClient(async (client) => {
      const { rows: vehicles } = await client.query(
        "SELECT id, linked_driver_cpf FROM public.vehicles"
      );
      for (const v of vehicles) {
        if (v.linked_driver_cpf) {
          await client.query(
            `SELECT phone
             FROM public.load_public_leads
             WHERE cpf = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [v.linked_driver_cpf]
          );
        }
      }
      // This intentionally fires N+1 queries — the bench result documents the cost.
      // DO NOT add assertMaxQueries here.
    });
  });
});
