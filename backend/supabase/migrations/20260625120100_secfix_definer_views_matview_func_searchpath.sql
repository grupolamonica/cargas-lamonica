-- Security hardening (2026-06-25): corrige achados ERROR/WARN do Supabase advisor
-- além do RLS (ver migração 20260625120000). Aplicado em PROD (lbpzkdecwraipbjbaajs)
-- via Supabase MCP; este arquivo é o registro forward idempotente.
--
-- Decisões verificadas adversarialmente (zero consumidor runtime via anon/authenticated;
-- backend usa role postgres/owner que bypassa RLS). Detalhe da análise no PR.

-- 1) lint 0010 (security_definer_view): v_clientes_com_rotas e v_rotas_com_tarifas
--    rodavam como owner (postgres) e, por isso, expunham clientes/rotas/rota_tarifas
--    (origem, destino, valor_frete, bonus) ao role anon ignorando RLS — vazamento.
--    Únicos consumidores são scripts admin/migrations (rodam como postgres). Revoga a
--    exposição via Data API e passa a respeitar a RLS de quem consulta.
DO $$
BEGIN
  IF to_regclass('public.v_clientes_com_rotas') IS NOT NULL THEN
    REVOKE ALL ON public.v_clientes_com_rotas FROM anon, authenticated;
    EXECUTE 'ALTER VIEW public.v_clientes_com_rotas SET (security_invoker = true)';
  END IF;
  IF to_regclass('public.v_rotas_com_tarifas') IS NOT NULL THEN
    REVOKE ALL ON public.v_rotas_com_tarifas FROM anon, authenticated;
    EXECUTE 'ALTER VIEW public.v_rotas_com_tarifas SET (security_invoker = true)';
  END IF;
END $$;

-- 2) lint 0016 (materialized_view_in_api): matview não respeita RLS, então anon lia
--    as métricas agregadas de claims. Backend lê/refresha como postgres/service_role
--    (mantidos). Revoga somente anon/authenticated.
DO $$
BEGIN
  IF to_regclass('public.load_claim_metrics_daily') IS NOT NULL THEN
    REVOKE ALL ON public.load_claim_metrics_daily FROM anon, authenticated;
  END IF;
END $$;

-- 3) lint 0011 (function_search_path_mutable): pin conservador de search_path.
--    Comportamento idêntico ao atual (search_path já resolvia public); só remove a
--    mutabilidade (hardening). Corpos usam refs qualificadas (auth.jwt(), public.*)
--    e builtins de pg_catalog. Nenhuma é SECURITY DEFINER.
ALTER FUNCTION public.current_app_role()                          SET search_path = pg_catalog, public;
ALTER FUNCTION public.current_operator_access_level()             SET search_path = pg_catalog, public;
ALTER FUNCTION public.tg_set_updated_at()                         SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_updated_at_pending_driver()             SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_external_registration_jobs_updated_at() SET search_path = pg_catalog, public;
