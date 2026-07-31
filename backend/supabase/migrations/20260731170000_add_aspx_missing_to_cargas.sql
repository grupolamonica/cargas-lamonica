-- Carga LANÇADA (Programação → lh_manual) cuja viagem SAIU do ASPX/SPX.
--
-- Acontece quando a Shopee cancela/remove a viagem do portal depois de o sistema já
-- ter lançado a carga (auto-lançamento DC-201 ou lançamento manual). A carga NUNCA é
-- apagada: ela continua na tela de Cargas (com o selo "Fora do ASPX") e SAI do Monitor
-- (não é mais uma viagem operável), e o operador é avisado pelo sino — sempre, com
-- re-aviso periódico enquanto a viagem não voltar.
--
-- aspx_missing_since     — quando a ausência foi detectada (NULL = viagem presente/OK)
-- aspx_missing_lh        — o LH que sumiu (congelado p/ o aviso, mesmo se lh_manual mudar)
-- aspx_missing_notified_at — último aviso emitido (base do re-aviso periódico)
--
-- Aditivas e idempotentes (ADD COLUMN IF NOT EXISTS) — retrocompatíveis, NULL = "presente".
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS aspx_missing_since TIMESTAMPTZ;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS aspx_missing_lh TEXT;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS aspx_missing_notified_at TIMESTAMPTZ;

-- Índice parcial: as varreduras (Monitor, re-aviso) só olham as cargas marcadas —
-- em regime normal é um conjunto vazio/minúsculo.
CREATE INDEX IF NOT EXISTS idx_cargas_aspx_missing_since
  ON public.cargas (aspx_missing_since)
  WHERE aspx_missing_since IS NOT NULL;
