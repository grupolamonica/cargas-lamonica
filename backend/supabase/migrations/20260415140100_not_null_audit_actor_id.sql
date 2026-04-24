-- =============================================================================
-- Migration: NOT NULL em actor_id nas tabelas de auditoria (M-05)
-- Auditoria 15/04/2026: eventos de auditoria sem actor_id dificultam rastreabilidade.
-- Backfill de NULLs com 'system' antes de aplicar restrição.
-- =============================================================================

-- load_claim_events: actor_id é o ID do autor da ação (driver, operator, system).
UPDATE public.load_claim_events
SET actor_id = 'system'
WHERE actor_id IS NULL;

ALTER TABLE public.load_claim_events
  ALTER COLUMN actor_id SET NOT NULL,
  ALTER COLUMN actor_id SET DEFAULT 'system';

-- load_public_lead_events: actor_id é o ID do autor da ação.
UPDATE public.load_public_lead_events
SET actor_id = 'system'
WHERE actor_id IS NULL;

ALTER TABLE public.load_public_lead_events
  ALTER COLUMN actor_id SET NOT NULL,
  ALTER COLUMN actor_id SET DEFAULT 'system';
