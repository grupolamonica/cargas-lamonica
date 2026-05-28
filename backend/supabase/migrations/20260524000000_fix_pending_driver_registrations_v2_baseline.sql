-- HOTFIX: prod (Supabase project lbpzkdec) tem pending_driver_registrations
-- no schema legacy (8 cols, criadas em 20260506000003) — sem as colunas/trigger/
-- indices necessarios para o cadastro v2 (wizard de candidatura, multi-draft,
-- whatsapp queue, dados bancarios, etc).
--
-- O projeto staging (oklksqv) ja tem este schema (criado fora do versionamento,
-- via Supabase Studio). Esta migration replica o estado de staging no prod sem
-- duplicar nada (IF NOT EXISTS em tudo) e tem timestamp anterior a
-- 20260525120000_pending_driver_registrations_multi_draft_indexes.sql porque
-- aquela depende destas colunas existirem.
--
-- Idempotente: pode ser re-aplicada com seguranca. Tabela em prod tem 0 linhas
-- no momento desta hotfix — sem backfill necessario, sem risco de perda de dados.

-- ── 1. Colunas cadastro v2 (16) ────────────────────────────────────────────
ALTER TABLE public.pending_driver_registrations
  ADD COLUMN IF NOT EXISTS versao_cadastro            text DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS pancary_autodeclaration    text,
  ADD COLUMN IF NOT EXISTS pancary_validation_source  text DEFAULT 'autodeclaration',
  ADD COLUMN IF NOT EXISTS dados_bancarios            jsonb,
  ADD COLUMN IF NOT EXISTS pis                        text,
  ADD COLUMN IF NOT EXISTS cor_veiculo                text,
  ADD COLUMN IF NOT EXISTS estado_civil               text,
  ADD COLUMN IF NOT EXISTS rastreador_detalhes        jsonb,
  ADD COLUMN IF NOT EXISTS whatsapp_notified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS carga_id                   text,
  ADD COLUMN IF NOT EXISTS driver_user_id             uuid,
  ADD COLUMN IF NOT EXISTS updated_at                 timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS whatsapp_retry_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_last_error        text,
  ADD COLUMN IF NOT EXISTS whatsapp_next_attempt_at   timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_status            text DEFAULT 'pending';

-- ── 2. Funcao + trigger BEFORE UPDATE para sliding window de updated_at ────
-- Padrao replicado de staging. save-draft.js depende deste comportamento
-- (D-05 + B-03 — TTL sliding 72h baseado em updated_at).
CREATE OR REPLACE FUNCTION public.set_updated_at_pending_driver()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pending_driver_updated_at
  ON public.pending_driver_registrations;
CREATE TRIGGER trg_pending_driver_updated_at
  BEFORE UPDATE ON public.pending_driver_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_pending_driver();

-- ── 3. Indices baseline do cadastro v2 ─────────────────────────────────────
-- Os 3 indices idx_pdr_* (multi-draft, drafts_with_carga, duplicate_cpf_placa)
-- sao criados pela migration 20260525120000_pending_driver_registrations_multi_draft_indexes.sql
-- que rodara depois desta na sequencia.

CREATE INDEX IF NOT EXISTS idx_pending_driver_v2
  ON public.pending_driver_registrations (versao_cadastro, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_driver_whatsapp_pending
  ON public.pending_driver_registrations (status, whatsapp_notified_at, whatsapp_next_attempt_at)
  WHERE versao_cadastro = 'v2' AND whatsapp_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_driver_draft_ttl
  ON public.pending_driver_registrations (updated_at)
  WHERE status = 'draft' AND versao_cadastro = 'v2';
