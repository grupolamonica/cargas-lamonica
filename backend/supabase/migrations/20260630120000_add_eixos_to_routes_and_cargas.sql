-- =============================================================================
-- MIGRATION: eixos por veículo na rota + carga (uma rota por veículo)
-- Date: 2026-06-30
-- Description:
--   Permite cadastrar a MESMA rota (origem→destino) com vários veículos, cada um
--   com seu valor/bônus. O "veículo" continua sendo o perfil canônico
--   (TRUCK/CARRETA/CARRETA_EXPRESSA/BITREM) + um número de eixos (dimensão nova).
--
--   - route_metrics_cache: nova coluna `eixos`; `perfil_padrao` passa a NOT NULL
--     (default CARRETA) para entrar na chave; unicidade vira
--     (origin_key, destination_key, perfil_padrao, eixos).
--   - cargas: nova coluna `eixos` (nullable = informativa; null/0 = genérico).
--
--   100% ADITIVA e retrocompatível: nenhuma coluna removida; cargas.eixos nullable.
--   O `perfil` permanece canônico → elegibilidade da disputa, candidatura, leads e
--   CHECK de veículo (vehicles / load_public_leads) ficam INTACTOS.
-- =============================================================================

BEGIN;

-- ============================================================
-- route_metrics_cache: eixos + perfil obrigatório + nova unicidade por veículo
-- ============================================================

ALTER TABLE public.route_metrics_cache
  ADD COLUMN IF NOT EXISTS eixos SMALLINT NOT NULL DEFAULT 0; -- 0 = genérico / não especificado

-- perfil_padrao precisa ser não-nulo para compor a chave de unicidade.
UPDATE public.route_metrics_cache
  SET perfil_padrao = 'CARRETA'
  WHERE perfil_padrao IS NULL;

ALTER TABLE public.route_metrics_cache
  ALTER COLUMN perfil_padrao SET DEFAULT 'CARRETA';

ALTER TABLE public.route_metrics_cache
  ALTER COLUMN perfil_padrao SET NOT NULL;

-- Troca a unicidade: era só (origin_key, destination_key) — o que travava
-- cadastrar o mesmo trecho com outro veículo.
ALTER TABLE public.route_metrics_cache
  DROP CONSTRAINT IF EXISTS route_metrics_cache_origin_destination_key_unique;

ALTER TABLE public.route_metrics_cache
  ADD CONSTRAINT route_metrics_cache_origin_dest_perfil_eixos_unique
  UNIQUE (origin_key, destination_key, perfil_padrao, eixos);

-- ============================================================
-- cargas: eixos informativo (nullable → retrocompatível)
-- ============================================================

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS eixos SMALLINT;

COMMIT;
