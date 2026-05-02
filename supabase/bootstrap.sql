CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.clientes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  logo_url TEXT,
  peso TEXT,
  tipo_veiculo TEXT,
  valor_frete TEXT,
  rastreamento TEXT,
  forma_pagamento TEXT,
  prazo_pagamento TEXT,
  antt TEXT,
  exige_rastreamento BOOLEAN NOT NULL DEFAULT false,
  exige_antt BOOLEAN NOT NULL DEFAULT false,
  exige_seguro BOOLEAN NOT NULL DEFAULT false,
  exige_carga_monitorada BOOLEAN NOT NULL DEFAULT false,
  reputacao_pagamento_rapido BOOLEAN NOT NULL DEFAULT false,
  reputacao_bom_pagador BOOLEAN NOT NULL DEFAULT false,
  reputacao_liberacao_rapida BOOLEAN NOT NULL DEFAULT false,
  reputacao_carga_organizada BOOLEAN NOT NULL DEFAULT false,
  reputacao_boa_comunicacao BOOLEAN NOT NULL DEFAULT false,
  observacoes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cargas (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
  data DATE NOT NULL,
  horario TIME NOT NULL,
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  perfil TEXT NOT NULL DEFAULT 'CARRETA',
  valor NUMERIC,
  bonus NUMERIC,
  bonus_exigencias TEXT,
  driver_visibility TEXT NOT NULL DEFAULT 'PUBLIC',
  status TEXT NOT NULL DEFAULT 'rascunho',
  is_template BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS distancia_km NUMERIC,
ADD COLUMN IF NOT EXISTS duracao_horas NUMERIC,
ADD COLUMN IF NOT EXISTS bonus NUMERIC,
ADD COLUMN IF NOT EXISTS bonus_exigencias TEXT,
ADD COLUMN IF NOT EXISTS driver_visibility TEXT,
ADD COLUMN IF NOT EXISTS sheet_lh TEXT,
ADD COLUMN IF NOT EXISTS sheet_tipo TEXT,
ADD COLUMN IF NOT EXISTS sheet_data_carregamento TEXT,
ADD COLUMN IF NOT EXISTS sheet_data_descarga TEXT,
ADD COLUMN IF NOT EXISTS sheet_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cargas_sheet_lh
ON public.cargas (sheet_lh)
WHERE sheet_lh IS NOT NULL AND sheet_lh <> '';

ALTER TABLE public.clientes
ADD COLUMN IF NOT EXISTS descricao TEXT,
ADD COLUMN IF NOT EXISTS logo_url TEXT,
ADD COLUMN IF NOT EXISTS prazo_pagamento TEXT,
ADD COLUMN IF NOT EXISTS exige_rastreamento BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_antt BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_seguro BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_carga_monitorada BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_pagamento_rapido BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_bom_pagador BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_liberacao_rapida BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_carga_organizada BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_boa_comunicacao BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.clientes
DROP COLUMN IF EXISTS nome_fantasia;

DROP INDEX IF EXISTS idx_clientes_nome_fantasia;

UPDATE public.clientes
SET
  exige_rastreamento = exige_rastreamento OR COALESCE(NULLIF(BTRIM(rastreamento), ''), '') <> '',
  exige_antt = exige_antt OR COALESCE(NULLIF(BTRIM(antt), ''), '') <> '';

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cargas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can insert clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can update clientes" ON public.clientes;
DROP POLICY IF EXISTS "Authenticated users can delete clientes" ON public.clientes;
DROP POLICY IF EXISTS "Anyone can view clientes of active cargas" ON public.clientes;

CREATE POLICY "Authenticated users can view clientes"
ON public.clientes
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert clientes"
ON public.clientes
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update clientes"
ON public.clientes
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated users can delete clientes"
ON public.clientes
FOR DELETE
TO authenticated
USING (true);

CREATE POLICY "Anyone can view clientes of active cargas"
ON public.clientes
FOR SELECT
TO anon
USING (
  EXISTS (
    SELECT 1
    FROM public.cargas
    WHERE cargas.cliente_id = clientes.id
      AND cargas.status = 'ativa'
  )
);

DROP POLICY IF EXISTS "Authenticated users can view cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can insert cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can update cargas" ON public.cargas;
DROP POLICY IF EXISTS "Authenticated users can delete cargas" ON public.cargas;
DROP POLICY IF EXISTS "Anyone can view active cargas" ON public.cargas;

CREATE POLICY "Authenticated users can view cargas"
ON public.cargas
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert cargas"
ON public.cargas
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update cargas"
ON public.cargas
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Authenticated users can delete cargas"
ON public.cargas
FOR DELETE
TO authenticated
USING (true);

CREATE POLICY "Anyone can view active cargas"
ON public.cargas
FOR SELECT
TO anon
USING (status = 'ativa');

CREATE INDEX IF NOT EXISTS idx_cargas_status_data_horario
ON public.cargas (status, data, horario);

CREATE INDEX IF NOT EXISTS idx_cargas_cliente_id
ON public.cargas (cliente_id);

CREATE INDEX IF NOT EXISTS idx_cargas_created_at
ON public.cargas (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cargas_origem_destino_created_at
ON public.cargas (origem, destino, created_at DESC)
WHERE distancia_km IS NOT NULL AND duracao_horas IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_nome
ON public.clientes (nome);

CREATE INDEX IF NOT EXISTS idx_clientes_created_at
ON public.clientes (created_at DESC);

CREATE TABLE IF NOT EXISTS public.route_metrics_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  origin_key TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  distancia_km NUMERIC NOT NULL,
  duracao_horas NUMERIC NOT NULL,
  tempo_estimado_horas NUMERIC,
  perfil_padrao TEXT,
  valor_padrao NUMERIC,
  bonus_padrao NUMERIC,
  ativa BOOLEAN NOT NULL DEFAULT true,
  observacoes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT route_metrics_cache_origin_destination_key_unique UNIQUE (origin_key, destination_key)
);

ALTER TABLE public.route_metrics_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view route cache" ON public.route_metrics_cache;
DROP POLICY IF EXISTS "Authenticated users can insert route cache" ON public.route_metrics_cache;
DROP POLICY IF EXISTS "Authenticated users can update route cache" ON public.route_metrics_cache;

CREATE POLICY "Authenticated users can view route cache"
ON public.route_metrics_cache
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert route cache"
ON public.route_metrics_cache
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update route cache"
ON public.route_metrics_cache
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);


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
END $$;

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
  SELECT NULLIF(
    lower(
      btrim(
        COALESCE(
          auth.jwt() -> 'app_metadata' ->> 'role',
          auth.jwt() -> 'user_metadata' ->> 'role',
          ''
        )
      )
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.current_operator_access_level()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN public.current_app_role() <> 'operator' THEN NULL
    WHEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '') IS NULL THEN 'advanced'
    WHEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '') IN ('advanced', 'intermediate')
      THEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '')
    ELSE NULL
  END;
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

UPDATE public.cargas
SET driver_visibility = 'PUBLIC'
WHERE driver_visibility IS NULL OR BTRIM(driver_visibility) = '';

ALTER TABLE public.cargas
ALTER COLUMN driver_visibility SET DEFAULT 'PUBLIC';

ALTER TABLE public.cargas
ALTER COLUMN driver_visibility SET NOT NULL;

ALTER TABLE public.cargas
DROP CONSTRAINT IF EXISTS cargas_status_check;

ALTER TABLE public.cargas
ADD CONSTRAINT cargas_status_check
CHECK (status IN ('DRAFT', 'OPEN', 'RESERVED', 'BOOKED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'FAILED'));

ALTER TABLE public.cargas
DROP CONSTRAINT IF EXISTS cargas_driver_visibility_check;

ALTER TABLE public.cargas
ADD CONSTRAINT cargas_driver_visibility_check
CHECK (driver_visibility IN ('PUBLIC', 'PREMIUM'));

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
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));

CREATE POLICY "Operators can update cargas"
ON public.cargas
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'))
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));

CREATE POLICY "Operators can delete cargas"
ON public.cargas
FOR DELETE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'));

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
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update clientes"
ON public.clientes
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can delete clientes"
ON public.clientes
FOR DELETE
TO authenticated
USING (public.current_operator_access_level() = 'advanced');

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
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update route cache"
ON public.route_metrics_cache
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

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
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

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

CREATE TABLE IF NOT EXISTS public.load_public_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id uuid NOT NULL REFERENCES public.cargas(id) ON DELETE CASCADE,
  cpf text NOT NULL,
  phone text NOT NULL,
  horse_plate text NOT NULL,
  trailer_plate text NOT NULL,
  trailer_plate_2 text NOT NULL DEFAULT '',
  vehicle_type text NOT NULL,
  status text NOT NULL DEFAULT 'PRE_REGISTERED',
  pre_registered_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz,
  whatsapp_clicked_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  pii_redacted_at timestamptz,
  validation_status text NOT NULL DEFAULT 'PENDING',
  validation_checked_at timestamptz,
  validation_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT load_public_leads_status_check CHECK (
    status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED', 'CANCELLED')
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'load_public_leads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.load_public_leads;
  END IF;
END $$;

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

CREATE TABLE IF NOT EXISTS public.security_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role text,
  resource_type text,
  resource_id text,
  action text,
  outcome text NOT NULL,
  request_ip text,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
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

ALTER TABLE public.load_public_leads
  ADD COLUMN IF NOT EXISTS trailer_plate_2 text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_load_public_leads_load_status_queue
ON public.load_public_leads (load_id, status, queued_at, created_at, id);

CREATE INDEX IF NOT EXISTS idx_load_public_leads_queued_at
ON public.load_public_leads (queued_at)
WHERE queued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_approved_by
ON public.load_public_leads (approved_by)
WHERE approved_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_pii_redacted_at
ON public.load_public_leads (pii_redacted_at, approved_at, updated_at)
WHERE pii_redacted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_validation_status
ON public.load_public_leads (validation_status, validation_checked_at DESC);

DROP INDEX IF EXISTS ux_load_public_leads_active_identity;

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_public_leads_active_identity
ON public.load_public_leads (load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2)
WHERE status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED');

CREATE INDEX IF NOT EXISTS idx_load_public_lead_events_load_created_at
ON public.load_public_lead_events (load_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cargas_reserved_public_lead_id
ON public.cargas (reserved_public_lead_id)
WHERE reserved_public_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_event_created_at
ON public.security_audit_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_actor_created_at
ON public.security_audit_logs (actor_user_id, created_at DESC);

ALTER TABLE public.load_public_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.load_public_lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view public load leads" ON public.load_public_leads;
DROP POLICY IF EXISTS "Operators can update public load leads" ON public.load_public_leads;
DROP POLICY IF EXISTS "Operators can view public lead events" ON public.load_public_lead_events;
DROP POLICY IF EXISTS "Operators can view security audit logs" ON public.security_audit_logs;

CREATE POLICY "Operators can view public load leads"
ON public.load_public_leads
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can update public load leads"
ON public.load_public_leads
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'))
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));

CREATE POLICY "Operators can view public lead events"
ON public.load_public_lead_events
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can view security audit logs"
ON public.security_audit_logs
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');

-- Analytics events (sponsor clicks, driver region views)
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type text NOT NULL,
  data jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
  ON public.analytics_events(event_type, created_at DESC);
