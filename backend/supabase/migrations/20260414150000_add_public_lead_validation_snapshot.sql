ALTER TABLE public.load_public_leads
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS validation_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS validation_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_validation_status
ON public.load_public_leads (validation_status, validation_checked_at DESC);
