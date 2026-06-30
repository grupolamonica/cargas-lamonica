-- Adiciona colunas para persistir o resultado da consulta BRK (Brasil Risk) no perfil
-- do motorista. Espelha o padrao da vigencia Angellira: consulta read-only de aptidao
-- (motorista + cavalo + carreta) que alimenta um badge na area do operador.
-- Estas colunas sao preenchidas automaticamente quando o sync BRK esta habilitado
-- (feature-flag BRK_SYNC_ENABLED=1) e preservam o ultimo valor bom quando o servico
-- esta indisponivel.

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS brk_status        text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brk_conjunto_apto boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brk_valid_until   date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brk_status_text   text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brk_details       jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brk_checked_at    timestamptz DEFAULT NULL;

-- Indice parcial para consultas de vigencia proxima a vencer (alerta 30 dias).
-- Filtra apenas motoristas com data de vigencia preenchida.
CREATE INDEX IF NOT EXISTS idx_driver_profiles_brk_vigency
  ON public.driver_profiles (brk_valid_until)
  WHERE brk_valid_until IS NOT NULL;

COMMENT ON COLUMN public.driver_profiles.brk_status IS 'Status do conjunto no BRK: vigente|expirado|nao_conforme|nao_cadastrado|parcial|erro';
COMMENT ON COLUMN public.driver_profiles.brk_conjunto_apto IS 'true quando o conjunto (motorista + cavalo + carreta) esta apto no BRK';
COMMENT ON COLUMN public.driver_profiles.brk_valid_until IS 'Menor data de validade (YYYY-MM-DD) entre os componentes do conjunto no BRK';
COMMENT ON COLUMN public.driver_profiles.brk_status_text IS 'Descricao textual do status BRK (label, ex: Apto - vence 27/07/2026)';
COMMENT ON COLUMN public.driver_profiles.brk_details IS 'Detalhe por componente do conjunto no BRK: { motorista, cavalo, carreta }';
COMMENT ON COLUMN public.driver_profiles.brk_checked_at IS 'Timestamp da ultima consulta contra o servico BRK';
