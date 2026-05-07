/**
 * bench-harness.js — Unified re-export of both test harnesses.
 *
 * load-claims harness: full schema (load_claims, load_claim_events,
 *   load_public_leads, idempotency_records, vehicles, ...). Use for claim-
 *   layer and vehicles benchmarks.
 *
 * operator-admin harness: slimmer schema focused on operator read-models,
 *   route_metrics_cache. Use for read-model and route benchmarks.
 *
 * Both harnesses use pg-mem (in-memory PostgreSQL). They run independently
 * with separate pg-mem instances.
 */

// ── Load-claims harness (full schema) ───────────────────────────────────────
export {
  resetTestDatabase,
  closeTestDatabase,
  withPgClient,
  withPgTransaction,
  query,
  seedUser,
  seedDriverProfile,
  seedClient,
  seedLoad,
  expireReservation,
  updateDriverProfile,
  getLoad,
  getClaim,
  getPublicLead,
  getClaimsByLoad,
  getPublicLeadsByLoad,
  getEventsByLoad,
  getPublicLeadEventsByLoad,
  getIdempotencyRecords,
  buildIdempotencyKey,
  buildDriverBatch,
} from "../../src/application/load-claims/test-harness.js";

// ── Operator-admin harness (operator read-models, vehicles, routes) ──────────
export {
  resetTestDatabase as resetOperatorDatabase,
  closeTestDatabase as closeOperatorDatabase,
  withPgClient as withOperatorPgClient,
  withPgTransaction as withOperatorPgTransaction,
  query as operatorQuery,
  seedUser as seedOperatorUser,
  seedCliente,
  seedCargo,
  seedDriverProfile as seedOperatorDriverProfile,
  seedLoadClaim,
  seedRoute,
  seedPublicLead,
  seedVehicle,
} from "../../src/application/operator-admin/test-harness.js";
