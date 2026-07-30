-- 20260730120000_create_kpi_schema_grafana.sql
--
-- Schema `kpi`: views read-only de indicadores para o Grafana da empresa
-- (painel de TV da operação). Ver monitoring/README.md.
--
-- Modelo de segurança:
--   * As views executam com os privilégios do OWNER (postgres), que bypassa
--     o RLS das tabelas base — deliberado: as tabelas de origem são
--     deny-all/service_role (20260625120000) e as views expõem SOMENTE
--     agregados, sem PII (nenhum nome, CPF, telefone ou payload jsonb).
--   * O role `grafana_ro` é criado NOLOGIN e enxerga apenas o schema kpi.
--     Passo manual pós-migration (senha NUNCA neste repo):
--       ALTER ROLE grafana_ro LOGIN PASSWORD '<senha-gerada>';
--   * Fuso: agregações diárias em America/Sao_Paulo (mesmo padrão de
--     backend/src/domain/operator-admin/driver-flow-metrics.js).

CREATE SCHEMA IF NOT EXISTS kpi;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
    CREATE ROLE grafana_ro NOLOGIN;
  END IF;
END
$$;

-- ── Cadastros de motorista (pending_driver_registrations) ───────────────────
-- Espelha queryCadastros (driver-flow-metrics.js:382): draft não conta como
-- cadastro realizado; 'pendente' é o balde de revisão do operador.
CREATE OR REPLACE VIEW kpi.cadastros_status_atual AS
SELECT status, count(*)::int AS total
FROM public.pending_driver_registrations
WHERE status <> 'draft'
GROUP BY status;

CREATE OR REPLACE VIEW kpi.cadastros_dia AS
SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) FILTER (WHERE status <> 'draft')::int  AS realizados,
       count(*) FILTER (WHERE status = 'pendente')::int AS pendentes_criados
FROM public.pending_driver_registrations
GROUP BY 1;

-- ── Funil de candidaturas públicas (load_public_leads) ──────────────────────
-- Cada timestamp do funil vira um evento no dia correspondente (espelha
-- queryFunnel, driver-flow-metrics.js:54).
CREATE OR REPLACE VIEW kpi.leads_funil_dia AS
SELECT dia,
       sum(pre_registered)::int AS pre_registered,
       sum(queued)::int         AS queued,
       sum(approved)::int       AS approved,
       sum(cancelled)::int      AS cancelled
FROM (
  SELECT (pre_registered_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
         1 AS pre_registered, 0 AS queued, 0 AS approved, 0 AS cancelled
  FROM public.load_public_leads
  WHERE pre_registered_at IS NOT NULL
  UNION ALL
  SELECT (queued_at AT TIME ZONE 'America/Sao_Paulo')::date, 0, 1, 0, 0
  FROM public.load_public_leads
  WHERE queued_at IS NOT NULL
  UNION ALL
  SELECT (approved_at AT TIME ZONE 'America/Sao_Paulo')::date, 0, 0, 1, 0
  FROM public.load_public_leads
  WHERE approved_at IS NOT NULL
  UNION ALL
  SELECT (updated_at AT TIME ZONE 'America/Sao_Paulo')::date, 0, 0, 0, 1
  FROM public.load_public_leads
  WHERE status = 'CANCELLED'
) eventos
GROUP BY dia;

-- ── Cargas por status ────────────────────────────────────────────────────────
-- Templates ficam fora de qualquer contagem de negócio.
CREATE OR REPLACE VIEW kpi.cargas_status_atual AS
SELECT status, count(*)::int AS total
FROM public.cargas
WHERE COALESCE(is_template, false) = false
GROUP BY status;

-- ── Claims por dia (load_claim_events) ──────────────────────────────────────
-- View própria em vez de load_claim_metrics_daily: aquela tem definições
-- conflitantes (view vs matview) em 4 migrations distintas.
CREATE OR REPLACE VIEW kpi.claims_dia AS
SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*) FILTER (WHERE event_type = 'CLAIM_CREATED')::int    AS claims_created,
       count(*) FILTER (WHERE event_type = 'CLAIM_WAITLISTED')::int AS claims_waitlisted,
       count(*) FILTER (WHERE event_type = 'LOAD_RESERVED')::int    AS reservations_created,
       count(*) FILTER (WHERE event_type = 'CLAIM_CONFIRMED')::int  AS claims_confirmed,
       count(*) FILTER (WHERE event_type = 'CLAIM_EXPIRED')::int    AS claims_expired,
       count(*) FILTER (WHERE event_type = 'CLAIM_PROMOTED')::int   AS claims_promoted,
       count(*) FILTER (WHERE event_type = 'CLAIM_REJECTED')::int   AS claims_rejected
FROM public.load_claim_events
GROUP BY 1;

-- ── Automação Aprovar → Angellira/SPX/Unificada ─────────────────────────────
-- Último job por cadastro+target (mesma CTE de
-- cadastros-com-erro-read-model.js:37) e erros das últimas 24h.
CREATE OR REPLACE VIEW kpi.automacao_jobs_atual AS
SELECT DISTINCT ON (cadastro_id, target)
       cadastro_id, target, step, status, attempts, created_at, finished_at
FROM public.external_registration_jobs
ORDER BY cadastro_id, target, created_at DESC;

CREATE OR REPLACE VIEW kpi.automacao_erros_24h AS
SELECT target, count(*)::int AS erros
FROM public.external_registration_jobs
WHERE status = 'ERROR'
  AND created_at > now() - interval '24 hours'
GROUP BY target;

-- ── Grants: grafana_ro enxerga só o schema kpi ──────────────────────────────
GRANT USAGE ON SCHEMA kpi TO grafana_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA kpi TO grafana_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA kpi GRANT SELECT ON TABLES TO grafana_ro;
