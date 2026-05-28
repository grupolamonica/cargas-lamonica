-- =============================================================================
-- Migration: Performance Hardening — Indexes for Dashboard, RLS, Audit Cleanup
-- Triggered by perf audit (2026-05-28).
--
-- Adds:
--   1. cargas (status, created_at DESC) composite — dashboard ORDER BY
--   2. cargas (cliente_id) partial — supports anon RLS EXISTS subquery on clientes
--   3. cargas (sheet_lh) — supports sheet sync keyset pagination
--   4. load_claim_events (created_at) BRIN — large append-only time-series
--   5. security_audit_logs (created_at) BRIN — same pattern
--   6. pending_driver_registrations partial GIN on dados (cpf path)
--
-- All idempotent. NOT using CREATE INDEX CONCURRENTLY here because Supabase
-- migrations run in a transaction by default; lockwait on production is
-- short (these tables are not the busiest). For the LARGEST tables, prefer
-- running `CREATE INDEX CONCURRENTLY` out-of-band before applying.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. cargas (status, created_at DESC) — operator dashboard ORDER BY pattern.
--    Existing idx_cargas_status covers status-only; existing idx_cargas_status_data
--    indexes by data (DESC NULLS LAST), but dashboard queries ORDER BY
--    created_at DESC + id DESC. Partial keeps it small (excludes cold statuses).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_status_created_at
  ON public.cargas (status, created_at DESC, id DESC)
  WHERE status NOT IN ('EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED');


-- ---------------------------------------------------------------------------
-- 2. cargas (cliente_id) WHERE status='ativa' AND is_template=false —
--    supports the anon RLS predicate on clientes (subquery EXISTS).
--    Very small partial index since most cargas are NOT in that state.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_cliente_active_template
  ON public.cargas (cliente_id)
  WHERE status = 'ativa' AND is_template = false;


-- ---------------------------------------------------------------------------
-- 3. cargas (sheet_lh) — sheet sync paginates by ORDER BY sheet_lh ASC.
--    NOT NULL partial keeps it small (linhas geradas manualmente não têm
--    sheet_lh).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cargas_sheet_lh
  ON public.cargas (sheet_lh)
  WHERE sheet_lh IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. load_claim_events (created_at) BRIN — table cresce ~5k+/dia, queries
--    de auditoria por janela temporal são range scans naturais. BRIN é 100x
--    menor que B-tree para esse padrão e suficiente quando dados são
--    inseridos cronologicamente.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_claim_events_created_at_brin
  ON public.load_claim_events USING BRIN (created_at);


-- ---------------------------------------------------------------------------
-- 5. security_audit_logs (created_at) BRIN — same time-series pattern.
--    Audit cleanup queries (WHERE created_at < now() - interval '90 days')
--    scan janelas grandes.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'security_audit_logs') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_security_audit_logs_created_at_brin ON public.security_audit_logs USING BRIN (created_at)';
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 6. pending_driver_registrations — operator leads N+1 mitigation.
--    Sub-query atualmente faz DISTINCT ON cpf FROM pending_driver_registrations
--    WHERE status IN (5 statuses) — partial index sobre status acelera o
--    filter; expr index sobre dados->'motorista'->>'cpf' acelera o group key.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pending_driver_registrations') THEN
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_pending_driver_registrations_active_cpf
        ON public.pending_driver_registrations ((dados->'motorista'->>'cpf'), created_at DESC)
        WHERE status IN ('pendente', 'em_revisao', 'em_analise', 'submitted', 'draft')
    $sql$;
  END IF;
END$$;
