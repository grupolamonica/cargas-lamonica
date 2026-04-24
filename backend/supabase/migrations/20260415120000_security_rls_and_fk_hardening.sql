-- =============================================================================
-- Migration: Security RLS Hardening + FK Fix
-- Corrige C-05, C-06, C-07 identificados na auditoria de segurança (15/04/2026)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- C-07: Corrigir FK em cargas.created_by sem ON DELETE
-- ---------------------------------------------------------------------------
-- A FK existente nao tem ON DELETE, o que causa registros orfaos quando
-- um usuario e deletado do auth.users. Adicionamos ON DELETE SET NULL.

ALTER TABLE public.cargas
  DROP CONSTRAINT IF EXISTS cargas_created_by_fkey;

ALTER TABLE public.cargas
  ADD CONSTRAINT cargas_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES auth.users(id)
    ON DELETE SET NULL;


-- ---------------------------------------------------------------------------
-- C-06: RLS policies para load_claims (INSERT / UPDATE / DELETE ausentes)
-- ---------------------------------------------------------------------------

-- Apenas drivers autenticados podem inserir claims proprios
CREATE POLICY "driver pode inserir claim proprio"
  ON public.load_claims
  FOR INSERT
  WITH CHECK (driver_id = auth.uid());

-- Apenas o backend (service_role) pode atualizar claims
CREATE POLICY "somente service pode atualizar claim"
  ON public.load_claims
  FOR UPDATE
  USING (auth.role() = 'service_role');

-- Claims nao podem ser deletados diretamente — sao imutaveis por negocio
CREATE POLICY "claims nao podem ser deletados"
  ON public.load_claims
  FOR DELETE
  USING (false);


-- ---------------------------------------------------------------------------
-- C-05: RLS policies para tabelas de audit trail (INSERT imutavel, sem UPDATE/DELETE)
-- ---------------------------------------------------------------------------

-- load_claim_events: apenas service_role pode inserir, ninguem pode alterar/deletar
CREATE POLICY "service pode inserir load_claim_events"
  ON public.load_claim_events
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "load_claim_events nao podem ser alterados"
  ON public.load_claim_events
  FOR UPDATE
  USING (false);

CREATE POLICY "load_claim_events nao podem ser deletados"
  ON public.load_claim_events
  FOR DELETE
  USING (false);


-- load_public_lead_events: idem
CREATE POLICY "service pode inserir load_public_lead_events"
  ON public.load_public_lead_events
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "load_public_lead_events nao podem ser alterados"
  ON public.load_public_lead_events
  FOR UPDATE
  USING (false);

CREATE POLICY "load_public_lead_events nao podem ser deletados"
  ON public.load_public_lead_events
  FOR DELETE
  USING (false);


-- security_audit_logs: idem
CREATE POLICY "service pode inserir security_audit_logs"
  ON public.security_audit_logs
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "security_audit_logs nao podem ser alterados"
  ON public.security_audit_logs
  FOR UPDATE
  USING (false);

CREATE POLICY "security_audit_logs nao podem ser deletados"
  ON public.security_audit_logs
  FOR DELETE
  USING (false);
