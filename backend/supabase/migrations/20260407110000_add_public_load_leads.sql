CREATE TABLE IF NOT EXISTS public.load_public_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  cpf text NOT NULL,
  phone text NOT NULL,
  horse_plate text NOT NULL,
  trailer_plate text NOT NULL,
  vehicle_type text NOT NULL,
  status text NOT NULL DEFAULT 'PRE_REGISTERED',
  pre_registered_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  whatsapp_clicked_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT load_public_leads_status_check CHECK (
    status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED', 'CANCELLED')
  )
);

DROP TRIGGER IF EXISTS set_load_public_leads_updated_at ON public.load_public_leads;
CREATE TRIGGER set_load_public_leads_updated_at
BEFORE UPDATE ON public.load_public_leads
FOR EACH ROW
EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS public.load_public_lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.load_public_leads(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS reserved_public_lead_id uuid;

ALTER TABLE public.cargas
  DROP CONSTRAINT IF EXISTS cargas_reserved_public_lead_id_fkey;

ALTER TABLE public.cargas
  ADD CONSTRAINT cargas_reserved_public_lead_id_fkey
  FOREIGN KEY (reserved_public_lead_id)
  REFERENCES public.load_public_leads(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_load_status_queue
ON public.load_public_leads (load_id, status, queued_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_load_public_leads_queued_at
ON public.load_public_leads (queued_at)
WHERE queued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_approved_by
ON public.load_public_leads (approved_by)
WHERE approved_by IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_public_leads_active_identity
ON public.load_public_leads (load_id, cpf, phone, horse_plate, trailer_plate)
WHERE status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_load_public_lead_events_load_created_at
ON public.load_public_lead_events (load_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cargas_reserved_public_lead_id
ON public.cargas (reserved_public_lead_id)
WHERE reserved_public_lead_id IS NOT NULL;

ALTER TABLE public.load_public_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.load_public_lead_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view public load leads" ON public.load_public_leads;
DROP POLICY IF EXISTS "Operators can update public load leads" ON public.load_public_leads;
DROP POLICY IF EXISTS "Operators can view public lead events" ON public.load_public_lead_events;

CREATE POLICY "Operators can view public load leads"
ON public.load_public_leads
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update public load leads"
ON public.load_public_leads
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can view public lead events"
ON public.load_public_lead_events
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');
