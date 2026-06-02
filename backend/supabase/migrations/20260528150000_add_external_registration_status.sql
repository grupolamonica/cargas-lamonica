-- DC-115 (Sprint 1 / Epic DC-111): persistir status do cadastro externo
-- (Angellira agora; SPX no Sprint 2) por motorista + audit log granular.
--
-- - Adiciona colunas em public.driver_profiles para refletir o status atual
--   do motorista em cada plataforma externa (Angellira, SPX).
-- - Cria public.external_registration_jobs como audit log + suporte a retry
--   por etapa (proprietario, cavalo, carreta, motorista, spx_motorista,
--   risk_doc).
--
-- Mantém as colunas existentes (angellira_status / angellira_valid_until /
-- angellira_status_text / angellira_checked_at) — referem-se a validação de
-- vigência via /profile/query e continuam alimentadas pelo fluxo de
-- candidatura. As colunas novas (*_registration_*) referem-se ao CADASTRO
-- efetivo via sidecar — semanticamente distintas.

-- ── 1. Colunas em driver_profiles — Angellira ────────────────────────────
ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS angellira_registration_status text
    CHECK (angellira_registration_status IS NULL OR angellira_registration_status IN (
      'PENDING', 'IN_PROGRESS', 'OK', 'ERROR', 'SKIPPED'
    )),
  ADD COLUMN IF NOT EXISTS angellira_driver_id   text,
  ADD COLUMN IF NOT EXISTS angellira_owner_id    text,
  ADD COLUMN IF NOT EXISTS angellira_vehicle_ids jsonb DEFAULT '{}'::jsonb,  -- {cavalo, carreta}
  ADD COLUMN IF NOT EXISTS angellira_registration_at timestamptz,
  ADD COLUMN IF NOT EXISTS angellira_last_error  jsonb;

CREATE INDEX IF NOT EXISTS idx_driver_profiles_angellira_reg_status
  ON public.driver_profiles (angellira_registration_status)
  WHERE angellira_registration_status IS NOT NULL;

COMMENT ON COLUMN public.driver_profiles.angellira_registration_status IS
  'Status do CADASTRO Angellira (distingue-se de angellira_status que é vigência): PENDING|IN_PROGRESS|OK|ERROR|SKIPPED';
COMMENT ON COLUMN public.driver_profiles.angellira_driver_id IS
  'ID do motorista no Angellira (retornado pelo /api/robo/motorista_api/iniciar)';
COMMENT ON COLUMN public.driver_profiles.angellira_owner_id IS
  'ID do proprietário no Angellira (PF ou PJ)';
COMMENT ON COLUMN public.driver_profiles.angellira_vehicle_ids IS
  'IDs dos veículos cadastrados: {"cavalo": "X", "carreta": "Y"}';
COMMENT ON COLUMN public.driver_profiles.angellira_last_error IS
  'Último erro estruturado retornado pelo bot ({code, message, etapa, acao, raw})';

-- ── 2. Colunas em driver_profiles — SPX (Sprint 2 popula) ────────────────
ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS spx_registration_status text
    CHECK (spx_registration_status IS NULL OR spx_registration_status IN (
      'PENDING', 'IN_PROGRESS', 'OK', 'ERROR', 'SKIPPED'
    )),
  ADD COLUMN IF NOT EXISTS spx_request_id        text,
  ADD COLUMN IF NOT EXISTS spx_driver_id         text,
  ADD COLUMN IF NOT EXISTS spx_registration_at   timestamptz,
  ADD COLUMN IF NOT EXISTS spx_last_error        jsonb;

CREATE INDEX IF NOT EXISTS idx_driver_profiles_spx_reg_status
  ON public.driver_profiles (spx_registration_status)
  WHERE spx_registration_status IS NOT NULL;

-- ── 3. Tabela external_registration_jobs ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.external_registration_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cadastro_id     uuid NOT NULL REFERENCES public.pending_driver_registrations(id) ON DELETE CASCADE,
  driver_user_id  uuid,
  target          text NOT NULL CHECK (target IN ('angellira', 'spx', 'unificada')),
  step            text NOT NULL,  -- proprietario|cavalo|carreta|motorista|spx_motorista|risk_doc
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'IN_PROGRESS', 'OK', 'ERROR')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  response        jsonb,
  error           jsonb,
  external_id     text,
  attempts        int NOT NULL DEFAULT 0,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_external_jobs_cadastro
  ON public.external_registration_jobs (cadastro_id);

CREATE INDEX IF NOT EXISTS idx_external_jobs_target_status
  ON public.external_registration_jobs (target, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_jobs_driver_user
  ON public.external_registration_jobs (driver_user_id)
  WHERE driver_user_id IS NOT NULL;

-- updated_at automatico (mesmo padrão de driver_profiles)
CREATE OR REPLACE FUNCTION public.set_external_registration_jobs_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_external_jobs_updated_at ON public.external_registration_jobs;
CREATE TRIGGER trg_external_jobs_updated_at
  BEFORE UPDATE ON public.external_registration_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_external_registration_jobs_updated_at();

-- RLS: somente service-role (backend) lê/escreve. Authenticated não acessa.
ALTER TABLE public.external_registration_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages external_registration_jobs"
  ON public.external_registration_jobs;
CREATE POLICY "service role manages external_registration_jobs"
  ON public.external_registration_jobs
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMENT ON TABLE public.external_registration_jobs IS
  'Audit log de cada etapa do cadastro em sistemas externos (Angellira, SPX, Unificada). Permite retry granular e diagnóstico de falhas. DC-115/DC-111.';
COMMENT ON COLUMN public.external_registration_jobs.target IS
  'Sistema externo: angellira | spx | unificada';
COMMENT ON COLUMN public.external_registration_jobs.step IS
  'Etapa do flow: proprietario|cavalo|carreta|motorista (angellira) | spx_motorista (spx) | risk_doc (unificada)';
COMMENT ON COLUMN public.external_registration_jobs.external_id IS
  'ID retornado pelo sistema externo (driverId, ownerId, vehicleId, request_id)';
