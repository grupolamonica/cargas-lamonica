/**
 * seed-factories.js — Bulk INSERT helpers for benchmarks.
 *
 * Each function accepts a queryFn (the `query` export from whichever harness
 * is active in the bench file). Uses multi-row VALUES to minimise round-trips.
 */

import crypto from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMultiRowInsert(table, columns, rows) {
  const placeholders = rows.map((_, rowIdx) => {
    const base = rowIdx * columns.length;
    const params = columns.map((_, colIdx) => `$${base + colIdx + 1}`);
    return `(${params.join(", ")})`;
  });
  const values = rows.flatMap((row) => row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`,
    values,
  };
}

// ── Vehicle batch ─────────────────────────────────────────────────────────────

/**
 * Insert `count` vehicles. Options:
 *   cpfStyle: 'formatted' = "123.456.789-00", 'raw' = "12345678900", 'null' = null
 *   withLinkedDriver: if true, also inserts auth.users rows and sets linked_driver_id
 */
export async function seedVehicleBatch(queryFn, count, { cpfStyle = "null" } = {}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const paddedIdx = String(i).padStart(6, "0");
    const cpf =
      cpfStyle === "formatted"
        ? `${paddedIdx.slice(0, 3)}.${paddedIdx.slice(0, 3)}.${paddedIdx.slice(0, 3)}-${String(i % 100).padStart(2, "0")}`
        : cpfStyle === "raw"
          ? `${paddedIdx}${paddedIdx}`.slice(0, 11)
          : null;
    return [
      crypto.randomUUID(),
      `PLT${paddedIdx}`,     // plate — unique
      "CARRETA",
      "HORSE",
      cpf,
      new Date().toISOString(),
      new Date().toISOString(),
    ];
  });

  const columns = [
    "id", "plate", "vehicle_type", "plate_role",
    "linked_driver_cpf", "created_at", "updated_at",
  ];
  const { sql, values } = buildMultiRowInsert("public.vehicles", columns, rows);
  await queryFn(sql, values);
  return rows.map((r) => ({ id: r[0], plate: r[1], linked_driver_cpf: r[4] }));
}

// ── Public lead batch ─────────────────────────────────────────────────────────

/**
 * Insert `count` public leads for a given loadId.
 *   cpfStyle: 'formatted' = "123.456.789-00", 'raw' = "12345678900"
 */
export async function seedPublicLeadBatch(
  queryFn,
  count,
  loadId,
  { cpfStyle = "raw" } = {}
) {
  const rows = Array.from({ length: count }, (_, i) => {
    const paddedIdx = String(i).padStart(6, "0");
    const cpf =
      cpfStyle === "formatted"
        ? `${paddedIdx.slice(0, 3)}.${paddedIdx.slice(0, 3)}.${paddedIdx.slice(0, 3)}-${String(i % 100).padStart(2, "0")}`
        : `${paddedIdx}${paddedIdx}`.slice(0, 11);
    return [
      crypto.randomUUID(),
      loadId,
      cpf,
      `+5511${paddedIdx}`.slice(0, 13),  // phone
      `HSE${paddedIdx}`,                  // horse_plate
      `TRL${paddedIdx}`,                  // trailer_plate
      "",
      "CARRETA",
      "PRE_REGISTERED",
      new Date().toISOString(),
      new Date().toISOString(),
    ];
  });

  const columns = [
    "id", "load_id", "cpf", "phone", "horse_plate", "trailer_plate",
    "trailer_plate_2", "vehicle_type", "status", "created_at", "updated_at",
  ];
  const { sql, values } = buildMultiRowInsert("public.load_public_leads", columns, rows);
  await queryFn(sql, values);
  return rows.map((r) => ({ id: r[0], cpf: r[2] }));
}

// ── Load batch ────────────────────────────────────────────────────────────────

export async function seedLoadBatch(queryFn, count, { status = "OPEN" } = {}) {
  const rows = Array.from({ length: count }, (_, i) => [
    crypto.randomUUID(),
    `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
    "08:00:00",
    `Origem ${i}`,
    `Destino ${i}`,
    "CARRETA",
    status,
    new Date().toISOString(),
    new Date().toISOString(),
  ]);

  const columns = [
    "id", "data", "horario", "origem", "destino", "perfil",
    "status", "created_at", "updated_at",
  ];
  const { sql, values } = buildMultiRowInsert("public.cargas", columns, rows);
  await queryFn(sql, values);
  return rows.map((r) => ({ id: r[0] }));
}

// ── Load-claim batch ──────────────────────────────────────────────────────────

/**
 * Insert `count` WAITLISTED claims for a load. Each claim needs its own user.
 * Also inserts the required auth.users rows first.
 */
export async function seedClaimBatch(queryFn, loadId, count) {
  // Seed users
  const userRows = Array.from({ length: count }, (_, i) => [
    crypto.randomUUID(),
    `driver${i}@bench.test`,
  ]);
  const { sql: userSql, values: userVals } = buildMultiRowInsert(
    "auth.users",
    ["id", "email"],
    userRows
  );
  await queryFn(userSql, userVals);

  // Seed driver profiles
  const profileRows = userRows.map((u) => [
    u[0],
    `Driver ${u[0].slice(0, 8)}`,
    "CARRETA",
    new Date().toISOString(),
    new Date().toISOString(),
  ]);
  const { sql: profSql, values: profVals } = buildMultiRowInsert(
    "public.driver_profiles",
    ["user_id", "full_name", "vehicle_profile", "created_at", "updated_at"],
    profileRows
  );
  await queryFn(profSql, profVals);

  // Seed claims — include all NOT NULL columns
  const now = new Date().toISOString();
  const claimRows = userRows.map((u, i) => [
    crypto.randomUUID(),
    loadId,
    u[0],
    "WAITLISTED",
    i + 1,
    `bench-idem-${i}-${crypto.randomUUID()}`,  // idempotency_key NOT NULL
    `bench-fp-${i}`,                            // request_fingerprint NOT NULL
    now,
    now,
  ]);
  const { sql: claimSql, values: claimVals } = buildMultiRowInsert(
    "public.load_claims",
    [
      "id", "load_id", "driver_id", "status", "queue_position",
      "idempotency_key", "request_fingerprint", "created_at", "updated_at",
    ],
    claimRows
  );
  await queryFn(claimSql, claimVals);

  return claimRows.map((r) => ({ id: r[0], driverId: r[2], queuePosition: r[4] }));
}

// ── Route metrics cache batch ─────────────────────────────────────────────────

export async function seedRouteBatch(queryFn, count) {
  const rows = Array.from({ length: count }, (_, i) => [
    crypto.randomUUID(),
    `origin_key_${i}`,
    `destination_key_${i}`,
    `Origem ${i}`,
    `Destino ${i}`,
    true,
    new Date().toISOString(),
    new Date().toISOString(),
  ]);

  const columns = [
    "id", "origin_key", "destination_key", "origem", "destino",
    "ativa", "created_at", "updated_at",
  ];
  const { sql, values } = buildMultiRowInsert("public.route_metrics_cache", columns, rows);
  await queryFn(sql, values);
  return rows.map((r) => ({ id: r[0], origin_key: r[1] }));
}
