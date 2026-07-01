-- Adiciona colunas para persistir o STATUS do motorista no SPX (Shopee Express) no
-- perfil do motorista. Espelha o padrao das vigencias Angellira/BRK, mas o SPX nao
-- expoe uma data de validade: o sinal util e o SITUACIONAL (ativo / inativo /
-- em outra agencia / pendente / bloqueado / nao cadastrado), obtido via lookup
-- read-only (POST /spx/motorista/lookup no sidecar SPX).
--
-- Estas colunas sao preenchidas automaticamente quando o sync SPX esta habilitado
-- (feature-flag SPX_VIGENCY_SYNC_ENABLED=1) e preservam o ultimo valor bom quando o
-- servico esta indisponivel.
--
-- NOTA: as colunas spx_registration_* (migracao 20260528150000) sao DISTINTAS —
-- rastreiam o disparo de CADASTRO nossa->SPX, nao a consulta de situacao.

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS spx_vigency_status      text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spx_vigency_status_text text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spx_vigency_encontrado  boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spx_vigency_details     jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spx_vigency_checked_at  timestamptz DEFAULT NULL;

COMMENT ON COLUMN public.driver_profiles.spx_vigency_status IS 'Situacao do motorista no SPX: ativo|inativo|outra_agencia|pendente|bloqueado|cadastrado|nao_cadastrado';
COMMENT ON COLUMN public.driver_profiles.spx_vigency_status_text IS 'Descricao textual da situacao SPX (label, ex: Inativo - reativar)';
COMMENT ON COLUMN public.driver_profiles.spx_vigency_encontrado IS 'true quando o motorista existe em alguma agencia no SPX';
COMMENT ON COLUMN public.driver_profiles.spx_vigency_details IS 'Flags cruas do lookup SPX: { na_minha_agencia, outra_agencia, inativo, bloqueado, request_pendente, retcode }';
COMMENT ON COLUMN public.driver_profiles.spx_vigency_checked_at IS 'Timestamp da ultima consulta de situacao contra o servico SPX';
