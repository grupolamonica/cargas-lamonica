-- Repom — estado da conversa de cadastro POR MOTORISTA (CPF), para "retomar de
-- onde parou" (§18 do PRD). ADITIVA e IDEMPOTENTE; sub-módulo OFF (nada consome).
--
-- Identidade = CPF só com dígitos. `registration_id` liga (opcional) ao cadastro
-- central em pending_driver_registrations — a MESMA espinha do wizard web, para
-- não duplicar motorista. Um índice único parcial garante no máximo UMA sessão
-- ativa por CPF.
--
-- Segurança: RLS ligada sem policy = somente service_role (backend).

CREATE TABLE IF NOT EXISTS public.repom_flow_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cpf             text NOT NULL,
  phone           text,
  flow_id         uuid REFERENCES public.repom_flows(id) ON DELETE SET NULL,
  current_node    text,
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'active',  -- active | paused | done | abandoned
  registration_id uuid,
  last_inbound_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repom_flow_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_repom_flow_sessions_cpf
  ON public.repom_flow_sessions (cpf);

CREATE UNIQUE INDEX IF NOT EXISTS uq_repom_flow_sessions_active_cpf
  ON public.repom_flow_sessions (cpf) WHERE status = 'active';

COMMENT ON TABLE public.repom_flow_sessions IS
  'Repom: estado/posição da conversa de cadastro por CPF (retomar). OFF por padrão.';
