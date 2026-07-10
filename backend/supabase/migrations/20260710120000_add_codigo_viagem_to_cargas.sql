-- =============================================================================
-- MIGRATION: codigo_viagem em cargas (código único de viagem, definido pelo operador)
-- Date: 2026-07-10
-- Description:
--   Cada carga pode ter um código de viagem único (texto livre, ex.: LT-2026-001).
--   Índice UNIQUE PARCIAL — permite N cargas SEM código (NULL/''), mas o código
--   informado não pode repetir. Segue o mesmo padrão de `sheet_lh`
--   (20260402143000): unicidade só quando preenchido.
--
--   100% aditiva: coluna nullable, nenhum dado existente afetado.
-- =============================================================================

BEGIN;

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS codigo_viagem TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cargas_codigo_viagem
  ON public.cargas (codigo_viagem)
  WHERE codigo_viagem IS NOT NULL AND codigo_viagem <> '';

COMMIT;
