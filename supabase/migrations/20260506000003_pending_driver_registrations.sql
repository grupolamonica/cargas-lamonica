-- Creates the table for pending driver registrations submitted via /cadastro public flow.
-- Drivers submit their form → row created with status 'pendente' → operator reviews in /motoristas.

CREATE TABLE IF NOT EXISTS public.pending_driver_registrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  id_cadastro      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT        NOT NULL DEFAULT 'pendente',
  -- pendente | em_revisao | aprovado | rejeitado
  dados            JSONB       NOT NULL,
  -- full form payload: { motorista, cavalo, carreta, operacional, proprietario }
  observacoes      TEXT,
  reviewed_at      TIMESTAMPTZ,
  reviewed_by_id   TEXT        -- operator user_id (auditing)
);

CREATE INDEX IF NOT EXISTS idx_pending_driver_status
  ON public.pending_driver_registrations(status, created_at DESC);
