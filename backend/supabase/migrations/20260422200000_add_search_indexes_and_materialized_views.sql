-- 1. Trigram indexes for text search (requires pg_trgm, already enabled in previous migration)

-- Clientes search — ILIKE on nome, descricao, forma_pagamento
CREATE INDEX IF NOT EXISTS idx_clientes_search_trgm
  ON public.clientes
  USING GIN ((
    COALESCE(nome, '') || ' ' ||
    COALESCE(descricao, '') || ' ' ||
    COALESCE(forma_pagamento, '')
  ) gin_trgm_ops);

-- Cargas search — ILIKE on origem, destino
CREATE INDEX IF NOT EXISTS idx_cargas_origem_trgm
  ON public.cargas
  USING GIN (COALESCE(origem, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_cargas_destino_trgm
  ON public.cargas
  USING GIN (COALESCE(destino, '') gin_trgm_ops);

-- 2. Generated column + index for driver CPF normalization
-- Eliminates the non-indexable REPLACE(REPLACE(dp.document_number,'.',''),'-','') in vehicle queries

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS document_number_digits TEXT
    GENERATED ALWAYS AS (
      REPLACE(REPLACE(REPLACE(document_number, '.', ''), '-', ''), '/', '')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_driver_profiles_doc_digits
  ON public.driver_profiles (document_number_digits);

-- 3. Functional index for clientes nome normalization (fixes findSheetClientId full scan)
CREATE INDEX IF NOT EXISTS idx_clientes_nome_lower
  ON public.clientes (LOWER(nome));

-- 4. Convert load_claim_metrics_daily to MATERIALIZED VIEW
-- Original view defined in 20260406150000_add_load_claims_system.sql

DROP VIEW IF EXISTS public.load_claim_metrics_daily;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.load_claim_metrics_daily AS
SELECT
  date_trunc('day', created_at) AS metric_day,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_CREATED') AS claims_created,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_WAITLISTED') AS claims_waitlisted,
  COUNT(*) FILTER (WHERE event_type = 'LOAD_RESERVED') AS reservations_created,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_CONFIRMED') AS claims_confirmed,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_EXPIRED') AS claims_expired,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_PROMOTED') AS claims_promoted,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_REJECTED') AS claims_rejected,
  COUNT(*) FILTER (WHERE event_type = 'IDEMPOTENCY_REPLAY') AS idempotent_replays
FROM public.load_claim_events
GROUP BY 1
;

CREATE UNIQUE INDEX IF NOT EXISTS idx_load_claim_metrics_daily_day
  ON public.load_claim_metrics_daily (metric_day);

COMMENT ON MATERIALIZED VIEW public.load_claim_metrics_daily IS
  'Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY public.load_claim_metrics_daily';
