-- =============================================================================
-- MIGRATION: rota_tarifas — eixos como dimensao de identidade da tarifa
-- Date: 2026-07-09
-- Description:
--   Habilita cadastrar multiplas tarifas por rota que compartilham o mesmo
--   perfil de veiculo mas diferem no numero de eixos (ex.: BITREM 6-eixos !=
--   BITREM 7-eixos com valor/bonus distintos).
--
--   - rota_tarifas.eixos SMALLINT NOT NULL DEFAULT 0 (0 = generico, mantem
--     retrocompatibilidade com dados backfillados sem eixos).
--   - Troca UNIQUE (rota_id, tipo_veiculo) para (rota_id, tipo_veiculo, eixos).
--   - Re-backfill de route_metrics_cache com a chave completa
--     (origem+destino+perfil+eixos), ON CONFLICT UPDATE — idempotente.
--   - Estende v_rotas_com_tarifas e v_clientes_com_rotas com eixos.
--
--   100% aditiva: coluna nova com DEFAULT 0 preserva as linhas existentes; a
--   troca de UNIQUE nao apaga dados (o backfill original ja gerou linhas
--   validas para os pares (rota, perfil)).
-- =============================================================================

BEGIN;

-- ------------------------------------------------------------------
-- 1. eixos em rota_tarifas
-- ------------------------------------------------------------------

ALTER TABLE public.rota_tarifas
  ADD COLUMN IF NOT EXISTS eixos SMALLINT NOT NULL DEFAULT 0;

-- ------------------------------------------------------------------
-- 2. UNIQUE inclui eixos
-- ------------------------------------------------------------------

ALTER TABLE public.rota_tarifas
  DROP CONSTRAINT IF EXISTS rota_tarifas_rota_veiculo_unique;

ALTER TABLE public.rota_tarifas
  ADD CONSTRAINT rota_tarifas_rota_veiculo_eixos_unique
  UNIQUE (rota_id, tipo_veiculo, eixos);

-- Indice de suporte para o lookup (origem,destino,perfil,eixos) do frontend
-- na edicao de carga. O UNIQUE ja cria indice por (rota_id,tipo_veiculo,eixos);
-- este adicional acelera o filtro sem rota_id previa.
CREATE INDEX IF NOT EXISTS idx_rota_tarifas_perfil_eixos
  ON public.rota_tarifas (tipo_veiculo, eixos)
  WHERE ativa = true;

-- ------------------------------------------------------------------
-- 3. Re-backfill de route_metrics_cache -> rota_tarifas com eixos
-- ------------------------------------------------------------------
-- O backfill original em 20260508000001 rodou antes da coluna `eixos` existir
-- em route_metrics_cache (adicionada em 20260630120000). Depois disso, uma
-- mesma rota pode ter no cache varias linhas para o mesmo perfil e eixos
-- distintos, e nenhuma delas foi refletida em rota_tarifas. Este backfill
-- resolve isso — idempotente.

INSERT INTO public.rota_tarifas (rota_id, tipo_veiculo, eixos, valor_frete, bonus, bonus_exigencias)
SELECT
  r.id,
  rmc.perfil_padrao,
  COALESCE(rmc.eixos, 0),
  rmc.valor_padrao,
  rmc.bonus_padrao,
  rmc.bonus_exigencias
FROM public.route_metrics_cache rmc
JOIN public.rotas r ON r.origem = rmc.origem AND r.destino = rmc.destino
WHERE rmc.perfil_padrao IS NOT NULL
  AND rmc.perfil_padrao = ANY (ARRAY['TRUCK','CARRETA','CARRETA_EXPRESSA','BITREM'])
ON CONFLICT (rota_id, tipo_veiculo, eixos) DO UPDATE SET
  valor_frete      = EXCLUDED.valor_frete,
  bonus            = EXCLUDED.bonus,
  bonus_exigencias = EXCLUDED.bonus_exigencias,
  updated_at       = now();

-- ------------------------------------------------------------------
-- 4. Views: incluir eixos
-- ------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_rotas_com_tarifas AS
SELECT
  r.id          AS rota_id,
  r.origem,
  r.destino,
  r.distancia_km,
  r.duracao_horas,
  r.rodovias,
  r.ativa,
  r.observacoes AS rota_observacoes,
  rt.id         AS tarifa_id,
  rt.tipo_veiculo,
  rt.eixos,
  rt.valor_frete,
  rt.bonus,
  rt.bonus_exigencias,
  rt.ativa      AS tarifa_ativa
FROM public.rotas r
LEFT JOIN public.rota_tarifas rt ON rt.rota_id = r.id;

-- v_clientes_com_rotas: usa rotas.cliente_id (1:N cliente -> rotas), modelo
-- vigente desde a migration 20260508000002 (cliente_rotas foi dropada).
CREATE OR REPLACE VIEW public.v_clientes_com_rotas AS
SELECT
  c.id          AS cliente_id,
  c.nome        AS cliente_nome,
  r.id          AS rota_id,
  r.origem,
  r.destino,
  r.distancia_km,
  r.duracao_horas,
  r.ativa       AS rota_ativa,
  rt.tipo_veiculo,
  rt.eixos,
  rt.valor_frete,
  rt.bonus,
  rt.bonus_exigencias
FROM public.clientes c
JOIN public.rotas r          ON r.cliente_id = c.id AND r.ativa = true
LEFT JOIN public.rota_tarifas rt ON rt.rota_id = r.id AND rt.ativa = true;

COMMIT;
