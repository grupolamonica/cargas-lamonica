-- 20260730200000_add_kpi_portal_visitas.sql
--
-- View kpi.portal_visitas_dia: acessos diários ao portal do motorista para
-- o painel de TV (driver_portal_visits registra 1 visita por IP a cada 30s,
-- então conta visitas reais, não requisições HTTP).
-- Já aplicada manualmente em prod via SQL editor em 2026-07-30 (idempotente).
-- Mesmo modelo de segurança do schema kpi (20260730120000): view owned by
-- postgres, agregada, sem PII (IPs só contados, nunca expostos).

CREATE OR REPLACE VIEW kpi.portal_visitas_dia AS
SELECT (visited_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       count(*)::int AS visitas,
       count(DISTINCT request_ip)::int AS visitantes_unicos
FROM public.driver_portal_visits
GROUP BY 1;

GRANT SELECT ON kpi.portal_visitas_dia TO grafana_ro;
