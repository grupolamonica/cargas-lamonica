-- Security hardening (2026-06-25): habilita RLS nas tabelas backend-only que
-- estavam expostas via Data API do PostgREST (Supabase advisor lint 0013
-- rls_disabled_in_public). Essas tabelas tinham GRANT total para o role `anon`
-- (que vai embutido na anon key, pública no bundle do frontend) e RLS desligado,
-- permitindo SELECT/INSERT/UPDATE/DELETE por qualquer um via
-- https://<ref>.supabase.co/rest/v1/<tabela>.
--
-- Sem policy, RLS = deny-all para anon/authenticated. O backend acessa via role
-- `postgres` (owner do pooler), que BYPASSA RLS — nenhum fluxo de runtime quebra
-- (frontend nunca lê essas tabelas direto; só backend). Verificado antes de aplicar.
--
-- Aplicado em PROD (lbpzkdecwraipbjbaajs) via Supabase MCP em 2026-06-25; este
-- arquivo é o registro forward idempotente para staging/fresh environments.
-- Idempotente: ENABLE ROW LEVEL SECURITY não falha se já habilitado.

ALTER TABLE IF EXISTS public.pending_driver_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.analytics_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.system_memory               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.idempotency_records         ENABLE ROW LEVEL SECURITY;
