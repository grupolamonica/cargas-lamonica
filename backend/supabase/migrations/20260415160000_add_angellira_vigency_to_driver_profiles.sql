-- Adiciona colunas para persistir o resultado da validacao Angellira no perfil
-- do motorista. Permite alertar operadores quando a vigencia esta proxima de vencer.
-- Estas colunas sao preenchidas automaticamente durante a validacao de leads publicos
-- e podem ser atualizadas manualmente pelo operador no futuro.

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS angellira_status text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS angellira_valid_until date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS angellira_status_text text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS angellira_checked_at timestamptz DEFAULT NULL;

-- Indice parcial para consultas de vigencia proxima a vencer (alerta 30 dias).
-- Filtra apenas motoristas com data de vigencia preenchida.
CREATE INDEX IF NOT EXISTS idx_driver_profiles_angellira_vigency
  ON public.driver_profiles (angellira_valid_until)
  WHERE angellira_valid_until IS NOT NULL;

COMMENT ON COLUMN public.driver_profiles.angellira_status IS 'Status do motorista no Angellira: FOUND, NOT_FOUND, UNAVAILABLE';
COMMENT ON COLUMN public.driver_profiles.angellira_valid_until IS 'Data de validade da vigencia no Angellira (YYYY-MM-DD)';
COMMENT ON COLUMN public.driver_profiles.angellira_status_text IS 'Descricao textual do status (ex: Conforme, Nao Conforme)';
COMMENT ON COLUMN public.driver_profiles.angellira_checked_at IS 'Timestamp da ultima verificacao contra a API do Angellira';
