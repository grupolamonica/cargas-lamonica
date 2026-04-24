-- =============================================================================
-- Migration: Índices de Performance Ausentes
-- Corrige H-05 e L-04 identificados na auditoria (15/04/2026)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- H-05: Índice standalone em load_claims.driver_id
-- Queries filtrando só por driver_id (sem status/created_at) fazem table scan.
-- Com 100+ drivers concorrentes testados, isso degrada significativamente.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_claims_driver_id
  ON public.load_claims (driver_id);


-- ---------------------------------------------------------------------------
-- L-04: Índice composto em load_public_leads (load_id, validation_status)
-- A página Leads filtra por load_id + validation_status frequentemente.
-- O índice existente é (validation_status, validation_checked_at) — não otimiza
-- queries por load_id + validation_status.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_public_leads_load_validation
  ON public.load_public_leads (load_id, validation_status);


-- ---------------------------------------------------------------------------
-- Extra: Índice em load_public_leads.pii_redacted_at para auditorias de redação
-- Queries de auditoria sobre redações recentes fariam full scan sem este índice.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_load_public_leads_pii_redacted_at
  ON public.load_public_leads (pii_redacted_at DESC)
  WHERE pii_redacted_at IS NOT NULL;
