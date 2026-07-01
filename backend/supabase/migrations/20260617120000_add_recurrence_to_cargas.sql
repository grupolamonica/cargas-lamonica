-- Recorrência de cargas (DC): uma carga que (a) avança sozinha a data para a
-- próxima ocorrência no mesmo horário e (b) ao ser reservada gera uma cópia OPEN
-- que mantém o padrão de recorrência (clone-on-reserve).
--
-- Idempotente / backward-compatible (ADD COLUMN IF NOT EXISTS) — pode rodar em
-- bancos que ainda não têm as colunas, alinhado ao padrão de schema-fallback do
-- código (writeCargo / read-models).

-- Liga/desliga a recorrência da carga. Default false: comportamento legado.
ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN;

UPDATE public.cargas
SET is_recurring = false
WHERE is_recurring IS NULL;

ALTER TABLE public.cargas
ALTER COLUMN is_recurring SET DEFAULT false;

ALTER TABLE public.cargas
ALTER COLUMN is_recurring SET NOT NULL;

-- Intervalo (em dias) entre ocorrências. NULL => diário (tratado como 1 no código).
ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS recurrence_interval_days INTEGER;

ALTER TABLE public.cargas
DROP CONSTRAINT IF EXISTS cargas_recurrence_interval_days_check;

ALTER TABLE public.cargas
ADD CONSTRAINT cargas_recurrence_interval_days_check
CHECK (recurrence_interval_days IS NULL OR recurrence_interval_days > 0);

-- Rastreabilidade da cadeia: aponta para a carga "mãe" original. Referência
-- soft (sem FK) para não bloquear a remoção de cargas antigas da cadeia.
ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID;

-- Índice parcial para o job de auto-avanço varrer só cargas recorrentes abertas.
CREATE INDEX IF NOT EXISTS idx_cargas_recurring_open
  ON public.cargas (data, horario)
  WHERE is_recurring = true AND status = 'OPEN';
