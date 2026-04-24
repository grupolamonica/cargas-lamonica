CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS public.load_claim_server_sequence_seq AS bigint;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', 'operator');
$$;

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reserved_claim_id uuid,
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_until timestamptz,
  ADD COLUMN IF NOT EXISTS booked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booked_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.cargas
SET status = CASE
  WHEN status = 'rascunho' THEN 'DRAFT'
  WHEN status = 'ativa' THEN 'OPEN'
  WHEN status = 'draft' THEN 'DRAFT'
  WHEN status = 'open' THEN 'OPEN'
  WHEN status = 'reserved' THEN 'RESERVED'
  WHEN status = 'booked' THEN 'BOOKED'
  WHEN status = 'expired' THEN 'EXPIRED'
  WHEN status = 'cancelled' THEN 'CANCELLED'
  WHEN status = 'completed' THEN 'COMPLETED'
  WHEN status = 'failed' THEN 'FAILED'
  ELSE status
END
WHERE status IN (
  'rascunho',
  'ativa',
  'draft',
  'open',
  'reserved',
  'booked',
  'expired',
  'cancelled',
  'completed',
  'failed'
);

UPDATE public.cargas
SET published_at = COALESCE(published_at, created_at)
WHERE published_at IS NULL
  AND status IN ('OPEN', 'RESERVED', 'BOOKED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED');

ALTER TABLE public.cargas
  DROP CONSTRAINT IF EXISTS cargas_status_check;

ALTER TABLE public.cargas
  ADD CONSTRAINT cargas_status_check
  CHECK (status IN ('DRAFT', 'OPEN', 'RESERVED', 'BOOKED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED'));

DROP TRIGGER IF EXISTS set_cargas_updated_at ON public.cargas;
CREATE TRIGGER set_cargas_updated_at
BEFORE UPDATE ON public.cargas
FOR EACH ROW
EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS public.driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  phone text,
  document_number text,
  vehicle_profile text NOT NULL DEFAULT 'CARRETA',
  active boolean NOT NULL DEFAULT true,
  documents_valid boolean NOT NULL DEFAULT true,
  antt_valid boolean NOT NULL DEFAULT true,
  tracking_enabled boolean NOT NULL DEFAULT false,
  insurance_valid boolean NOT NULL DEFAULT false,
  monitoring_capable boolean NOT NULL DEFAULT false,
  operational_blocked boolean NOT NULL DEFAULT false,
  allowed_regions text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_driver_profiles_updated_at ON public.driver_profiles;
CREATE TRIGGER set_driver_profiles_updated_at
BEFORE UPDATE ON public.driver_profiles
FOR EACH ROW
EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS public.load_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL,
  queue_position integer,
  server_sequence bigint NOT NULL DEFAULT nextval('public.load_claim_server_sequence_seq'),
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  request_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  confirmed_at timestamptz,
  expired_at timestamptz,
  rejected_reason text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT load_claims_status_check CHECK (
    status IN (
      'PENDING',
      'WON_RESERVATION',
      'WAITLISTED',
      'PROMOTED',
      'CONFIRMED',
      'EXPIRED',
      'REJECTED',
      'CANCELLED',
      'FAILED'
    )
  ),
  CONSTRAINT load_claims_queue_position_check CHECK (queue_position IS NULL OR queue_position > 0)
);

ALTER TABLE public.cargas
  DROP CONSTRAINT IF EXISTS cargas_reserved_claim_id_fkey;

ALTER TABLE public.cargas
  ADD CONSTRAINT cargas_reserved_claim_id_fkey
  FOREIGN KEY (reserved_claim_id)
  REFERENCES public.load_claims(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

DROP TRIGGER IF EXISTS set_load_claims_updated_at ON public.load_claims;
CREATE TRIGGER set_load_claims_updated_at
BEFORE UPDATE ON public.load_claims
FOR EACH ROW
EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TABLE IF NOT EXISTS public.load_claim_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  claim_id uuid REFERENCES public.load_claims(id) ON DELETE SET NULL,
  driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL,
  actor_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  scope text NOT NULL,
  driver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  response_status integer,
  response_body_json jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cargas_status_reserved_until
ON public.cargas (status, reserved_until)
WHERE status = 'RESERVED';

CREATE INDEX IF NOT EXISTS idx_cargas_reserved_claim_id
ON public.cargas (reserved_claim_id)
WHERE reserved_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cargas_reserved_driver_id
ON public.cargas (reserved_driver_id)
WHERE reserved_driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cargas_booked_driver_id
ON public.cargas (booked_driver_id)
WHERE booked_driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_profiles_vehicle_profile
ON public.driver_profiles (vehicle_profile);

CREATE INDEX IF NOT EXISTS idx_load_claims_load_status_order
ON public.load_claims (load_id, status, server_sequence, claimed_at, id);

CREATE INDEX IF NOT EXISTS idx_load_claims_driver_status_created_at
ON public.load_claims (driver_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_load_claims_idempotency_key
ON public.load_claims (idempotency_key, driver_id, load_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_claims_active_driver_load
ON public.load_claims (load_id, driver_id)
WHERE status IN ('WON_RESERVATION', 'WAITLISTED', 'PROMOTED', 'CONFIRMED');

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_claims_active_reservation_per_load
ON public.load_claims (load_id)
WHERE status IN ('WON_RESERVATION', 'PROMOTED');

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_claims_waitlist_position
ON public.load_claims (load_id, queue_position)
WHERE status = 'WAITLISTED' AND queue_position IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_claim_events_load_created_at
ON public.load_claim_events (load_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_load_claim_events_driver_created_at
ON public.load_claim_events (driver_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_idempotency_records_scope_key
ON public.idempotency_records (scope, driver_id, load_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
ON public.idempotency_records (expires_at);

CREATE OR REPLACE VIEW public.load_claim_metrics_daily AS
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
GROUP BY 1;

ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.load_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.load_claim_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can insert cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can update cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can delete cargas" ON public.cargas;
DROP POLICY IF EXISTS "Anyone can view active cargas" ON public.cargas;

CREATE POLICY "Operators can view cargas"
ON public.cargas
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert cargas"
ON public.cargas
FOR INSERT
TO authenticated
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update cargas"
ON public.cargas
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can delete cargas"
ON public.cargas
FOR DELETE
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Public can view driver visible cargas"
ON public.cargas
FOR SELECT
TO anon
USING (status IN ('OPEN', 'RESERVED', 'BOOKED'));

DROP POLICY IF EXISTS "Authenticated users can view clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can insert clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can update clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can delete clientes" ON public.clientes;
DROP POLICY IF EXISTS "Anyone can view clientes of active cargas" ON public.clientes;

CREATE POLICY "Operators can view clientes"
ON public.clientes
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert clientes"
ON public.clientes
FOR INSERT
TO authenticated
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update clientes"
ON public.clientes
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can delete clientes"
ON public.clientes
FOR DELETE
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Public can view clientes of visible cargas"
ON public.clientes
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM public.cargas
    WHERE cargas.cliente_id = clientes.id
      AND cargas.status IN ('OPEN', 'RESERVED', 'BOOKED')
  )
);

DROP POLICY IF EXISTS "Authenticated users can view route cache" ON public.route_metrics_cache;
DROP POLICY IF EXISTS "Authenticated users can insert route cache" ON public.route_metrics_cache;
DROP POLICY IF EXISTS "Authenticated users can update route cache" ON public.route_metrics_cache;

CREATE POLICY "Operators can view route cache"
ON public.route_metrics_cache
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert route cache"
ON public.route_metrics_cache
FOR INSERT
TO authenticated
WITH CHECK (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update route cache"
ON public.route_metrics_cache
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

DROP POLICY IF EXISTS "Drivers can view own profile" ON public.driver_profiles;
DROP POLICY IF EXISTS "Drivers can insert own profile" ON public.driver_profiles;
DROP POLICY IF EXISTS "Drivers can update own profile" ON public.driver_profiles;
DROP POLICY IF EXISTS "Operators can view driver profiles" ON public.driver_profiles;
DROP POLICY IF EXISTS "Operators can update driver profiles" ON public.driver_profiles;

CREATE POLICY "Drivers can view own profile"
ON public.driver_profiles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Drivers can insert own profile"
ON public.driver_profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Drivers can update own profile"
ON public.driver_profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Operators can view driver profiles"
ON public.driver_profiles
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update driver profiles"
ON public.driver_profiles
FOR UPDATE
TO authenticated
USING (public.current_app_role() = 'operator')
WITH CHECK (public.current_app_role() = 'operator');

DROP POLICY IF EXISTS "Drivers can view own claims" ON public.load_claims;
DROP POLICY IF EXISTS "Operators can view all claims" ON public.load_claims;

CREATE POLICY "Drivers can view own claims"
ON public.load_claims
FOR SELECT
TO authenticated
USING (auth.uid() = driver_id);

CREATE POLICY "Operators can view all claims"
ON public.load_claims
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

DROP POLICY IF EXISTS "Drivers can view own claim events" ON public.load_claim_events;
DROP POLICY IF EXISTS "Operators can view all claim events" ON public.load_claim_events;

CREATE POLICY "Drivers can view own claim events"
ON public.load_claim_events
FOR SELECT
TO authenticated
USING (auth.uid() = driver_id);

CREATE POLICY "Operators can view all claim events"
ON public.load_claim_events
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cargas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cargas;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'load_claims'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.load_claims;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'load_claim_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.load_claim_events;
  END IF;
END $$;
