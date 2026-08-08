-- DC-283 / ALTO-15 + BX-4 — trilha de auditoria confiável.
--
-- Dois problemas distintos na mesma tabela.
--
-- ALTO-15: a trilha não resiste a adulteração. As policies de RLS que a
-- protegem (`USING (false)`) só valem para clientes Supabase; o backend conecta
-- como superuser `postgres` e **bypassa RLS**, então hoje um UPDATE ou DELETE
-- na trilha passa em silêncio. Auditoria que pode ser reescrita sem deixar
-- rastro não serve como prova.
--
-- BX-4: `actor_user_id ... ON DELETE SET NULL` + nome resolvido ao vivo na
-- leitura (resolveOperatorDirectory). Apagar um operador anula a autoria de
-- todo o histórico dele de uma vez — exatamente o histórico que mais importaria.

-- ── BX-4: quem foi, gravado no momento do fato ──────────────────────────────
ALTER TABLE public.security_audit_logs
  ADD COLUMN IF NOT EXISTS actor_email TEXT;

COMMENT ON COLUMN public.security_audit_logs.actor_email IS
  'E-mail do ator capturado NO MOMENTO da escrita. Sobrevive à exclusão do usuário, que zera actor_user_id (ON DELETE SET NULL). A leitura prefere o diretório ao vivo e cai para cá quando o usuário não existe mais.';

-- ── ALTO-15: append-only imposto pelo banco, não pela aplicação ─────────────
CREATE OR REPLACE FUNCTION public.security_audit_logs_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'security_audit_logs e append-only: UPDATE bloqueado (DC-283/ALTO-15)';
  END IF;

  -- O expurgo por retenção (MED-9) é a ÚNICA remoção legítima, e precisa se
  -- declarar: `SET LOCAL app.audit_purge = 'on'` dentro da transação. Sem essa
  -- válvula, ligar a retenção exigiria derrubar o guard — e aí ele não volta.
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('app.audit_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION
      'security_audit_logs e append-only: DELETE exige SET LOCAL app.audit_purge = ''on'' (DC-283/ALTO-15)';
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_audit_logs_append_only ON public.security_audit_logs;
CREATE TRIGGER trg_security_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.security_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.security_audit_logs_append_only();

-- TRUNCATE não dispara trigger de linha — sem este bloco, uma linha de SQL
-- apaga a trilha inteira e o guard acima nem é consultado.
CREATE OR REPLACE FUNCTION public.security_audit_logs_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'security_audit_logs e append-only: TRUNCATE bloqueado (DC-283/ALTO-15)';
END;
$$;

DROP TRIGGER IF EXISTS trg_security_audit_logs_no_truncate ON public.security_audit_logs;
CREATE TRIGGER trg_security_audit_logs_no_truncate
  BEFORE TRUNCATE ON public.security_audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.security_audit_logs_no_truncate();

-- LIMITE CONHECIDO, registrado de propósito: superuser continua podendo dar
-- DROP TRIGGER. Isto não torna a trilha imutável — torna a adulteração um ato
-- deliberado e visível no schema, em vez de um UPDATE silencioso. Imutabilidade
-- de verdade exige destino externo append-only (object-lock) ou hash encadeado,
-- e está fora do escopo deste PR.
