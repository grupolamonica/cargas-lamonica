-- =============================================================================
-- MIGRATION: Schema Audit + Route Remodel
-- Date: 2026-05-08
-- Description:
--   FASE 1: Remove colunas mortas/legado de clientes, corrige inconsistências
--           de constraints e tipos.
--   FASE 2: Cria entidades rotas / rota_tarifas / cliente_rotas (N:M),
--           adiciona cargas.rota_id, migra dados de route_metrics_cache.
--
-- Backward-compatible: nenhuma coluna existente é removida de tabelas com
-- dados operacionais (cargas, load_claims, etc.) nesta migration.
-- FASE 1 remove apenas colunas mortas de clientes que não têm código lendo.
-- =============================================================================

BEGIN;

-- ============================================================
-- FASE 1-A: Remover colunas mortas de clientes
-- ============================================================

-- clientes.peso — nunca lida nem escrita por nenhum use-case
ALTER TABLE public.clientes
  DROP COLUMN IF EXISTS peso;

-- clientes.rastreamento — dado migrado para exige_rastreamento BOOLEAN
-- (bootstrap.sql já fez: exige_rastreamento = ... COALESCE(rastreamento,'') <> '')
ALTER TABLE public.clientes
  DROP COLUMN IF EXISTS rastreamento;

-- clientes.antt — dado migrado para exige_antt BOOLEAN
ALTER TABLE public.clientes
  DROP COLUMN IF EXISTS antt;

-- clientes.valor_frete — TEXT sem uso em nenhuma regra de negócio
ALTER TABLE public.clientes
  DROP COLUMN IF EXISTS valor_frete;

-- clientes.tipo_veiculo — flat TEXT sem constraint; o fallback em
-- load-claims/eligibility.js nunca é atingido pois cargas.perfil é NOT NULL.
-- Remover a coluna aqui. O código de aplicação deve remover a referência
-- a cliente_tipo_veiculo em: service.js:137 e eligibility.js:4.
ALTER TABLE public.clientes
  DROP COLUMN IF EXISTS tipo_veiculo;

-- ============================================================
-- FASE 1-B: Adicionar CHECK constraints para vehicle_type
-- (alinha com CANONICAL_VEHICLE_PROFILES do domínio)
-- ============================================================

ALTER TABLE public.vehicles
  DROP CONSTRAINT IF EXISTS vehicles_vehicle_type_check;

ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_vehicle_type_check
  CHECK (vehicle_type IS NULL OR vehicle_type = ANY (
    ARRAY['TRUCK','CARRETA','CARRETA_EXPRESSA','BITREM']
  ));

ALTER TABLE public.load_public_leads
  DROP CONSTRAINT IF EXISTS load_public_leads_vehicle_type_check;

ALTER TABLE public.load_public_leads
  ADD CONSTRAINT load_public_leads_vehicle_type_check
  CHECK (vehicle_type = ANY (
    ARRAY['TRUCK','CARRETA','CARRETA_EXPRESSA','BITREM']
  ));

-- ============================================================
-- FASE 1-C: Adicionar FK faltante em vehicles
-- ============================================================

-- vehicles.linked_driver_id → driver_profiles.user_id estava sem FK
ALTER TABLE public.vehicles
  DROP CONSTRAINT IF EXISTS vehicles_linked_driver_id_fkey;

ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_linked_driver_id_fkey
  FOREIGN KEY (linked_driver_id)
  REFERENCES public.driver_profiles(user_id)
  ON DELETE SET NULL;

-- ============================================================
-- FASE 1-D: Corrigir divergência load_claim_metrics_daily
-- (bootstrap.sql define como VIEW; prod é MATERIALIZED VIEW)
-- Padronizar para MATERIALIZED VIEW com refresh manual.
-- ============================================================

-- DROP seguro — trata VIEW e MATERIALIZED VIEW independente do estado do banco
DO $$
BEGIN
  DROP MATERIALIZED VIEW IF EXISTS public.load_claim_metrics_daily;
  DROP VIEW IF EXISTS public.load_claim_metrics_daily;
EXCEPTION WHEN wrong_object_type THEN
  DROP MATERIALIZED VIEW IF EXISTS public.load_claim_metrics_daily;
END $$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.load_claim_metrics_daily AS
SELECT
  date_trunc('day', created_at) AS metric_day,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_CREATED')    AS claims_created,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_WAITLISTED') AS claims_waitlisted,
  COUNT(*) FILTER (WHERE event_type = 'LOAD_RESERVED')    AS reservations_created,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_CONFIRMED')  AS claims_confirmed,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_EXPIRED')    AS claims_expired,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_PROMOTED')   AS claims_promoted,
  COUNT(*) FILTER (WHERE event_type = 'CLAIM_REJECTED')   AS claims_rejected,
  COUNT(*) FILTER (WHERE event_type = 'IDEMPOTENCY_REPLAY') AS idempotent_replays
FROM public.load_claim_events
GROUP BY 1
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_claim_metrics_daily_day
  ON public.load_claim_metrics_daily (metric_day);

-- ============================================================
-- FASE 2-A: Criar entidade rotas
-- (promove route_metrics_cache de cache para catálogo canônico)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rotas (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  origem        TEXT        NOT NULL,
  destino       TEXT        NOT NULL,
  distancia_km  NUMERIC,
  duracao_horas NUMERIC,
  rodovias      TEXT,              -- ex: "BR-116, BA-526"
  ativa         BOOLEAN     NOT NULL DEFAULT true,
  observacoes   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rotas_origem_destino_unique UNIQUE (origem, destino)
);

DROP TRIGGER IF EXISTS set_rotas_updated_at ON public.rotas;
CREATE TRIGGER set_rotas_updated_at
  BEFORE UPDATE ON public.rotas
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.rotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view rotas"
  ON public.rotas FOR SELECT TO authenticated
  USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert rotas"
  ON public.rotas FOR INSERT TO authenticated
  WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update rotas"
  ON public.rotas FOR UPDATE TO authenticated
  USING  (public.current_operator_access_level() = 'advanced')
  WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can delete rotas"
  ON public.rotas FOR DELETE TO authenticated
  USING (public.current_operator_access_level() = 'advanced');

CREATE INDEX IF NOT EXISTS idx_rotas_origem_destino
  ON public.rotas (origem, destino);

CREATE INDEX IF NOT EXISTS idx_rotas_ativa
  ON public.rotas (ativa)
  WHERE ativa = true;

-- ============================================================
-- FASE 2-B: Criar rota_tarifas
-- (N:M rota × tipo_veiculo com preço — resolve o impasse central)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rota_tarifas (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rota_id          UUID        NOT NULL REFERENCES public.rotas(id) ON DELETE CASCADE,
  tipo_veiculo     TEXT        NOT NULL,
  valor_frete      NUMERIC,
  bonus            NUMERIC,
  bonus_exigencias TEXT,
  ativa            BOOLEAN     NOT NULL DEFAULT true,
  observacoes      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rota_tarifas_rota_veiculo_unique UNIQUE (rota_id, tipo_veiculo),
  CONSTRAINT rota_tarifas_tipo_veiculo_check CHECK (
    tipo_veiculo = ANY (ARRAY['TRUCK','CARRETA','CARRETA_EXPRESSA','BITREM'])
  )
);

DROP TRIGGER IF EXISTS set_rota_tarifas_updated_at ON public.rota_tarifas;
CREATE TRIGGER set_rota_tarifas_updated_at
  BEFORE UPDATE ON public.rota_tarifas
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.rota_tarifas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view rota_tarifas"
  ON public.rota_tarifas FOR SELECT TO authenticated
  USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert rota_tarifas"
  ON public.rota_tarifas FOR INSERT TO authenticated
  WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update rota_tarifas"
  ON public.rota_tarifas FOR UPDATE TO authenticated
  USING  (public.current_operator_access_level() = 'advanced')
  WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can delete rota_tarifas"
  ON public.rota_tarifas FOR DELETE TO authenticated
  USING (public.current_operator_access_level() = 'advanced');

CREATE INDEX IF NOT EXISTS idx_rota_tarifas_rota_id
  ON public.rota_tarifas (rota_id);

CREATE INDEX IF NOT EXISTS idx_rota_tarifas_tipo_veiculo
  ON public.rota_tarifas (tipo_veiculo);

-- ============================================================
-- FASE 2-C: Criar cliente_rotas (N:M clientes ↔ rotas)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cliente_rotas (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  cliente_id UUID        NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  rota_id    UUID        NOT NULL REFERENCES public.rotas(id)    ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cliente_rotas_unique UNIQUE (cliente_id, rota_id)
);

ALTER TABLE public.cliente_rotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can view cliente_rotas"
  ON public.cliente_rotas FOR SELECT TO authenticated
  USING (public.current_app_role() = 'operator');

CREATE POLICY "Operators can insert cliente_rotas"
  ON public.cliente_rotas FOR INSERT TO authenticated
  WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can delete cliente_rotas"
  ON public.cliente_rotas FOR DELETE TO authenticated
  USING (public.current_operator_access_level() = 'advanced');

CREATE INDEX IF NOT EXISTS idx_cliente_rotas_cliente_id
  ON public.cliente_rotas (cliente_id);

CREATE INDEX IF NOT EXISTS idx_cliente_rotas_rota_id
  ON public.cliente_rotas (rota_id);

-- ============================================================
-- FASE 2-D: Adicionar rota_id em cargas (nullable, backward-compat)
-- ============================================================

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS rota_id UUID REFERENCES public.rotas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cargas_rota_id
  ON public.cargas (rota_id)
  WHERE rota_id IS NOT NULL;

-- ============================================================
-- FASE 2-E: Migrar route_metrics_cache → rotas + rota_tarifas
-- ============================================================

-- 2-E.1: Popular rotas a partir de route_metrics_cache
INSERT INTO public.rotas (origem, destino, distancia_km, duracao_horas, ativa, observacoes)
SELECT
  origem,
  destino,
  distancia_km,
  duracao_horas,
  ativa,
  observacoes
FROM public.route_metrics_cache
ON CONFLICT (origem, destino) DO UPDATE SET
  distancia_km  = EXCLUDED.distancia_km,
  duracao_horas = EXCLUDED.duracao_horas,
  ativa         = EXCLUDED.ativa,
  observacoes   = EXCLUDED.observacoes,
  updated_at    = now();

-- 2-E.2: Popular rota_tarifas a partir de perfil_padrao/valor_padrao existentes
INSERT INTO public.rota_tarifas (rota_id, tipo_veiculo, valor_frete, bonus, bonus_exigencias)
SELECT
  r.id,
  rmc.perfil_padrao,
  rmc.valor_padrao,
  rmc.bonus_padrao,
  rmc.bonus_exigencias
FROM public.route_metrics_cache rmc
JOIN public.rotas r ON r.origem = rmc.origem AND r.destino = rmc.destino
WHERE rmc.perfil_padrao IS NOT NULL
  AND rmc.perfil_padrao = ANY (ARRAY['TRUCK','CARRETA','CARRETA_EXPRESSA','BITREM'])
ON CONFLICT (rota_id, tipo_veiculo) DO UPDATE SET
  valor_frete      = EXCLUDED.valor_frete,
  bonus            = EXCLUDED.bonus,
  bonus_exigencias = EXCLUDED.bonus_exigencias,
  updated_at       = now();

-- ============================================================
-- FASE 2-F: Criar view de conveniência rota_tarifas_completo
-- (para read-models do operador: rota + todas as tarifas por veículo)
-- ============================================================

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
  rt.valor_frete,
  rt.bonus,
  rt.bonus_exigencias,
  rt.ativa      AS tarifa_ativa
FROM public.rotas r
LEFT JOIN public.rota_tarifas rt ON rt.rota_id = r.id;

-- ============================================================
-- FASE 2-G: Criar view de conveniência clientes_com_rotas
-- (para o formulário de cadastro de carga: selecionar cliente → ver rotas)
-- ============================================================

CREATE OR REPLACE VIEW public.v_clientes_com_rotas AS
SELECT
  c.id          AS cliente_id,
  c.nome        AS cliente_nome,
  r.id          AS rota_id,
  r.origem,
  r.destino,
  r.distancia_km,
  rt.tipo_veiculo,
  rt.valor_frete,
  rt.bonus,
  rt.bonus_exigencias
FROM public.clientes c
JOIN public.cliente_rotas cr ON cr.cliente_id = c.id
JOIN public.rotas r          ON r.id = cr.rota_id AND r.ativa = true
LEFT JOIN public.rota_tarifas rt ON rt.rota_id = r.id AND rt.ativa = true;

COMMIT;

-- ============================================================
-- FASE 3 (executar após validação da Fase 2 em produção)
-- Remover colunas de pricing do route_metrics_cache — dados já em rota_tarifas
-- Executar como migration separada quando Fase 2 estiver estável.
-- ============================================================
--
-- ALTER TABLE public.route_metrics_cache
--   DROP COLUMN IF EXISTS perfil_padrao,
--   DROP COLUMN IF EXISTS valor_padrao,
--   DROP COLUMN IF EXISTS bonus_padrao,
--   DROP COLUMN IF EXISTS bonus_exigencias;
--
-- DROP TABLE IF EXISTS public.motoristas_historico;
-- (apenas após confirmar que nenhum processo ancora em motoristas_historico)
-- ============================================================
