-- =============================================================================
-- MIGRATION: Route Single Cliente (1:N cliente -> rotas)
-- Date: 2026-05-08
-- Description:
--   Refina o relacionamento criado em 20260508000001:
--   N:M (cliente_rotas) -> 1:N (rotas.cliente_id).
--
--   Modelo final: cada rota tem no máximo 1 cliente (ou NULL).
--   Um cliente pode ter várias rotas exclusivas.
--
--   Migra dados existentes em cliente_rotas para rotas.cliente_id
--   (em caso de rota associada a múltiplos clientes na N:M, mantém o
--    primeiro vínculo registrado por created_at e descarta os outros
--    com warning no log da migration).
-- =============================================================================

BEGIN;

-- ============================================================
-- 1. Adicionar coluna rotas.cliente_id (NULLable, FK)
-- ============================================================

ALTER TABLE public.rotas
  ADD COLUMN IF NOT EXISTS cliente_id UUID
    REFERENCES public.clientes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rotas_cliente_id
  ON public.rotas (cliente_id)
  WHERE cliente_id IS NOT NULL;

-- ============================================================
-- 2. Migrar dados de cliente_rotas para rotas.cliente_id
--    Estratégia: para cada rota, o cliente mais antigo vence
--    (ORDER BY cr.created_at ASC, cr.id ASC).
-- ============================================================

DO $$
DECLARE
  conflict_count INT := 0;
BEGIN
  -- Conta rotas com múltiplos clientes (apenas para log)
  SELECT COUNT(*) INTO conflict_count
  FROM (
    SELECT rota_id
    FROM public.cliente_rotas
    GROUP BY rota_id
    HAVING COUNT(*) > 1
  ) AS multi;

  IF conflict_count > 0 THEN
    RAISE NOTICE 'Atenção: % rota(s) tinham múltiplos clientes na N:M. Mantendo o vínculo mais antigo.', conflict_count;
  END IF;

  -- Atualiza rotas.cliente_id com o cliente mais antigo de cada rota
  UPDATE public.rotas r
     SET cliente_id = sub.cliente_id
    FROM (
      SELECT DISTINCT ON (rota_id) rota_id, cliente_id
      FROM public.cliente_rotas
      ORDER BY rota_id, created_at ASC, id ASC
    ) AS sub
   WHERE r.id = sub.rota_id
     AND r.cliente_id IS NULL;
END $$;

-- ============================================================
-- 3. Drop tabela cliente_rotas (não mais necessária)
-- ============================================================

DROP TABLE IF EXISTS public.cliente_rotas CASCADE;

-- ============================================================
-- 4. Recriar view v_clientes_com_rotas usando JOIN direto
--    (CASCADE no DROP acima já dropou a view antiga)
-- ============================================================

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
  rt.valor_frete,
  rt.bonus,
  rt.bonus_exigencias
FROM public.clientes c
JOIN public.rotas r          ON r.cliente_id = c.id
LEFT JOIN public.rota_tarifas rt ON rt.rota_id = r.id AND rt.ativa = true;

-- ============================================================
-- 5. RLS: rotas já tem políticas (criadas em 20260508000001).
--    cliente_id é coluna nova, herda as políticas existentes
--    (operator-only read/insert/update/delete).
-- ============================================================

COMMIT;
