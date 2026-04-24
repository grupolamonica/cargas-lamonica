-- =============================================================================
-- Migration: Performance Indexes — Query Pattern Coverage
-- Covers missing indexes identified for date-range, status, cpf/phone dedup,
-- and claim event metrics queries (22/04/2026).
-- =============================================================================

-- pg_trgm not previously enabled — required by future text-search indexes.
-- Safe to enable now; harmless if already present (IF NOT EXISTS guard).
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ---------------------------------------------------------------------------
-- 1. cargas.data — date-range filtering in ManageCargas and DriverPortal
--    ordering. DESC NULLS LAST matches the typical ORDER BY direction.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_data
  ON public.cargas (data DESC NULLS LAST);


-- ---------------------------------------------------------------------------
-- 2. cargas.status — most-common filter across all cargo list queries.
--    Partial index excludes terminal statuses that are rarely re-queried,
--    keeping the index small and write-cheap.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_status
  ON public.cargas (status)
  WHERE status NOT IN ('EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED');


-- ---------------------------------------------------------------------------
-- 3. load_public_leads (cpf, phone) — driver dedup lookups in Motoristas page.
--    Partial index for active leads only (PRE_REGISTERED, QUEUED, APPROVED).
--    Note: valid status values are PRE_REGISTERED | QUEUED | APPROVED | CANCELLED
--    per the load_public_leads_status_check constraint.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_public_leads_cpf_phone
  ON public.load_public_leads (cpf, phone)
  WHERE status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED');


-- ---------------------------------------------------------------------------
-- 4. cargas (status, data) — composite for filtered date-range queries that
--    combine a status predicate with an ORDER BY data.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_status_data
  ON public.cargas (status, data DESC NULLS LAST)
  WHERE status NOT IN ('EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED');


-- ---------------------------------------------------------------------------
-- 5. load_claims (load_id, status) — claim status lookups by load.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_claims_load_id_status
  ON public.load_claims (load_id, status);


-- ---------------------------------------------------------------------------
-- 6. load_public_leads (load_id, status) — leads grouping queries.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_public_leads_load_id_status
  ON public.load_public_leads (load_id, status);


-- ---------------------------------------------------------------------------
-- 7. load_claim_events (claim_id, event_type) — metrics queries filtering
--    events by claim and type (e.g. counting ACCEPTED vs REJECTED per claim).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_claim_events_claim_id_event_type
  ON public.load_claim_events (claim_id, event_type);


-- ---------------------------------------------------------------------------
-- 8. load_claim_events (created_at) — daily metrics aggregation that groups
--    or filters events by date range.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_claim_events_created_at
  ON public.load_claim_events (created_at);
