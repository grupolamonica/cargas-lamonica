-- Phase 10: cargas_casadas (pacote de cargas) + viagem_id/ordem_viagem em cargas. Idempotente.
-- Plan ref: .planning/phases/10-cargas-casadas/10-01-PLAN.md
-- Decisions:  CONTEXT.md (D-01..D-08 LOCKED)
--
-- Idempotency: all DDL uses IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS guards.
-- Re-applying this migration is safe.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. TABLE public.cargas_casadas
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cargas_casadas (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text NOT NULL DEFAULT 'rascunho',
  valor_total         numeric,
  reserved_driver_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reserved_claim_id   uuid,
  booked_driver_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  version             integer NOT NULL DEFAULT 1,
  published_at        timestamptz,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- FK reserved_claim_id -> load_claims(id) with DEFERRABLE INITIALLY DEFERRED
-- (mirrors public.cargas.reserved_claim_id_fkey, 20260406150000 lines 138-146).
ALTER TABLE public.cargas_casadas
  DROP CONSTRAINT IF EXISTS cargas_casadas_reserved_claim_id_fkey;

ALTER TABLE public.cargas_casadas
  ADD CONSTRAINT cargas_casadas_reserved_claim_id_fkey
  FOREIGN KEY (reserved_claim_id)
  REFERENCES public.load_claims(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- Status CHECK (LOCKED set per D-04; lowercase Portuguese, DISTINCT from cargas.status uppercase).
ALTER TABLE public.cargas_casadas
  DROP CONSTRAINT IF EXISTS cargas_casadas_status_check;

ALTER TABLE public.cargas_casadas
  ADD CONSTRAINT cargas_casadas_status_check
  CHECK (status IN (
    'rascunho',
    'publicado',
    'reservado',
    'em_andamento',
    'concluido',
    'cancelado'
  ));

-- updated_at trigger reuses public.tg_set_updated_at() defined in 20260406150000.
DROP TRIGGER IF EXISTS set_cargas_casadas_updated_at ON public.cargas_casadas;
CREATE TRIGGER set_cargas_casadas_updated_at
BEFORE UPDATE ON public.cargas_casadas
FOR EACH ROW
EXECUTE FUNCTION public.tg_set_updated_at();

-- ============================================================================
-- 2. ALTER public.cargas — add viagem_id + ordem_viagem (nullable, backward-compat)
-- ============================================================================

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS viagem_id uuid REFERENCES public.cargas_casadas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ordem_viagem integer;

ALTER TABLE public.cargas
  DROP CONSTRAINT IF EXISTS cargas_ordem_viagem_check;

ALTER TABLE public.cargas
  ADD CONSTRAINT cargas_ordem_viagem_check
  CHECK (ordem_viagem IS NULL OR ordem_viagem > 0);

-- ============================================================================
-- 3. INDICES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_cargas_casadas_status
  ON public.cargas_casadas (status);

CREATE INDEX IF NOT EXISTS idx_cargas_casadas_status_published_at
  ON public.cargas_casadas (status, published_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_cargas_casadas_reserved_driver
  ON public.cargas_casadas (reserved_driver_id)
  WHERE reserved_driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cargas_viagem_id
  ON public.cargas (viagem_id)
  WHERE viagem_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cargas_viagem_ordem
  ON public.cargas (viagem_id, ordem_viagem)
  WHERE viagem_id IS NOT NULL;

-- ============================================================================
-- 4. ROW-LEVEL SECURITY — cargas_casadas
-- Mirrors policies on public.cargas (20260406150000 lines 257-286).
-- ============================================================================

ALTER TABLE public.cargas_casadas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view cargas_casadas"   ON public.cargas_casadas;
DROP POLICY IF EXISTS "Operators can insert cargas_casadas" ON public.cargas_casadas;
DROP POLICY IF EXISTS "Operators can update cargas_casadas" ON public.cargas_casadas;
DROP POLICY IF EXISTS "Operators can delete cargas_casadas" ON public.cargas_casadas;
DROP POLICY IF EXISTS "Public can view published cargas_casadas" ON public.cargas_casadas;

CREATE POLICY "Operators can view cargas_casadas"
ON public.cargas_casadas
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert cargas_casadas"
ON public.cargas_casadas
FOR INSERT
TO authenticated
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update cargas_casadas"
ON public.cargas_casadas
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can delete cargas_casadas"
ON public.cargas_casadas
FOR DELETE
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Public can view published cargas_casadas"
ON public.cargas_casadas
FOR SELECT
TO anon
USING (status IN ('publicado', 'reservado', 'em_andamento'));

-- ============================================================================
-- 5. REALTIME PUBLICATION
-- Pattern copied from 20260406150000 lines 423-454.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cargas_casadas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cargas_casadas;
  END IF;
END $$;
