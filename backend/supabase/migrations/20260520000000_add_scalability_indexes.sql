-- Migration: Indexes for scalability (DC-94 Sprint 2 — S2-DB-INDEXES)
-- Uses CONCURRENTLY to avoid locking tables in production.
-- Safe to run against an existing database with data.

-- 1. Partial index on cargas.cliente_id for common JOINs and ON DELETE CASCADE
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cargas_cliente_id
  ON public.cargas (cliente_id)
  WHERE cliente_id IS NOT NULL;

-- 2. Partial index on cargas(created_by, status) for per-operator RLS and digest queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cargas_created_by_status
  ON public.cargas (created_by, status)
  WHERE status NOT IN ('rascunho');

-- 3. Standalone index on load_claims.load_id for queries without status filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_load_claims_load_id
  ON public.load_claims (load_id);

-- 4. Partial index on active load_claims (reduces JSONB materialization cost)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_load_claims_driver_id_active
  ON public.load_claims (driver_id, created_at DESC)
  WHERE status IN ('PENDING', 'WON_RESERVATION', 'WAITLISTED', 'PROMOTED', 'CONFIRMED');

-- 5. Index on load_public_leads.load_id for JOIN in digest queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_load_public_leads_load_id
  ON public.load_public_leads (load_id)
  WHERE load_id IS NOT NULL;

-- 6. ANALYZE to update planner statistics
ANALYZE public.cargas;
ANALYZE public.load_claims;
ANALYZE public.clientes;
