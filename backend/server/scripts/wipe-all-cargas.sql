-- =============================================================================
-- WARNING: DESTRUCTIVE — This script deletes ALL cargo data.
-- LOCAL DEVELOPMENT ONLY — never run against production.
-- To confirm intent, this script will NOT run as-is.
-- You MUST remove the safety guard on the DELETE statement below before executing.
-- =============================================================================

-- =============================================================================
--  wipe-all-cargas.sql
--  Remove TODAS as cargas e dados relacionados do banco.
--
--  AVISO: operacao DESTRUTIVA e IRREVERSIVEL.
--  O usuario deve executar este script manualmente (via psql / painel Supabase),
--  de preferencia apos backup (pg_dump ou snapshot do Supabase).
--
--  Tabelas afetadas (ON DELETE CASCADE a partir de public.cargas):
--    - public.cargas                      (alvo)
--    - public.load_claims                 (FK -> cargas.id)
--    - public.load_claim_events           (FK -> cargas.id)
--    - public.load_claim_requests         (FK -> cargas.id)
--    - public.load_public_leads           (FK -> cargas.id)
--    - public.load_public_lead_events     (FK -> cargas.id)
--
--  Dados PRESERVADOS (nao sao afetados):
--    - public.clientes
--    - public.driver_profiles
--    - public.routes / route_metrics_cache
--    - public.vehicles
--    - public.sheet_monitor_snapshots
--    - auth.users
-- =============================================================================

BEGIN;

-- 1) Snapshot antes da limpeza: total de registros por tabela.
SELECT
  (SELECT COUNT(*) FROM public.cargas)                   AS cargas_antes,
  (SELECT COUNT(*) FROM public.load_claims)              AS load_claims_antes,
  (SELECT COUNT(*) FROM public.load_claim_events)        AS load_claim_events_antes,
  (SELECT COUNT(*) FROM public.load_claim_requests)      AS load_claim_requests_antes,
  (SELECT COUNT(*) FROM public.load_public_leads)        AS load_public_leads_antes,
  (SELECT COUNT(*) FROM public.load_public_lead_events)  AS load_public_lead_events_antes;

-- 2) Delecao em cascata. Todas as tabelas filhas com ON DELETE CASCADE
--    sao limpadas automaticamente pelo Postgres.
--
-- SAFETY GUARD: Remove the WHERE clause below to enable the DELETE.
-- REMOVE THE LINE BELOW TO ENABLE:
DELETE FROM public.cargas WHERE 1 = 0; -- Safety guard — delete "WHERE 1 = 0" to run

-- 3) Confirmacao apos a limpeza.
SELECT
  (SELECT COUNT(*) FROM public.cargas)                   AS cargas_depois,
  (SELECT COUNT(*) FROM public.load_claims)              AS load_claims_depois,
  (SELECT COUNT(*) FROM public.load_claim_events)        AS load_claim_events_depois,
  (SELECT COUNT(*) FROM public.load_claim_requests)      AS load_claim_requests_depois,
  (SELECT COUNT(*) FROM public.load_public_leads)        AS load_public_leads_depois,
  (SELECT COUNT(*) FROM public.load_public_lead_events)  AS load_public_lead_events_depois;

-- 4) Se os contadores estiverem todos zerados, confirme com COMMIT.
--    Caso contrario, execute ROLLBACK.
--
--    Substitua a linha abaixo por COMMIT ou ROLLBACK apos revisar o resultado:
-- COMMIT;
-- ROLLBACK;
