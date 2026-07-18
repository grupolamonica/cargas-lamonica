-- driver-outreach — módulo de mensagens proativas para motoristas (Wave A).
--
-- Duas tabelas de suporte, ambas backend-only (a conexão direta do backend é a
-- dona e escreve; o operador só lê via RLS, espelhando monitor_reservas):
--   * driver_outreach_optout — motoristas que pediram para não receber contato.
--   * driver_outreach_log     — histórico de contatos (dedupe/cooldown/auditoria).
--
-- Idempotente: CREATE ... IF NOT EXISTS. A detecção de oportunidades é derivada
-- (planilha/cadastros/leads/cargas) e não precisa de tabela própria.

-- ── Opt-out ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.driver_outreach_optout (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_key  text        NOT NULL,            -- CPF (dígitos) ou nome normalizado
  phone       text,                            -- telefone normalizado (dígitos), se conhecido
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid
);

-- Uma linha de opt-out por motorista (chave canônica = CPF ou nome normalizado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_outreach_optout_key
  ON public.driver_outreach_optout (driver_key);

-- ── Log de contatos ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.driver_outreach_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_key     text        NOT NULL,          -- CPF (dígitos) ou nome normalizado
  trigger        text        NOT NULL,          -- churn | lost_registration | abandonment | return_load | preferences
  channel        text        NOT NULL DEFAULT 'wa_link',   -- wa_link (operador clica) | evolution (auto)
  status         text        NOT NULL DEFAULT 'sent',      -- sent | failed | skipped
  phone          text,
  payload        jsonb       NOT NULL DEFAULT '{}',
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT driver_outreach_log_channel_chk CHECK (channel IN ('wa_link', 'evolution')),
  CONSTRAINT driver_outreach_log_status_chk  CHECK (status IN ('sent', 'failed', 'skipped'))
);

-- Consulta de dedupe/cooldown: "já contatei o motorista X pelo gatilho Y há pouco?"
CREATE INDEX IF NOT EXISTS idx_driver_outreach_log_driver_trigger
  ON public.driver_outreach_log (driver_key, trigger, created_at DESC);

-- ── RLS (espelha monitor_reservas: operador lê; backend é dono e escreve) ────
ALTER TABLE public.driver_outreach_optout ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view driver outreach optout" ON public.driver_outreach_optout;
CREATE POLICY "Operators can view driver outreach optout"
  ON public.driver_outreach_optout
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');

ALTER TABLE public.driver_outreach_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view driver outreach log" ON public.driver_outreach_log;
CREATE POLICY "Operators can view driver outreach log"
  ON public.driver_outreach_log
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
