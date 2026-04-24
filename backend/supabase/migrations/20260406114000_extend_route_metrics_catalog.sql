ALTER TABLE public.route_metrics_cache
ADD COLUMN IF NOT EXISTS tempo_estimado_horas NUMERIC,
ADD COLUMN IF NOT EXISTS perfil_padrao TEXT,
ADD COLUMN IF NOT EXISTS valor_padrao NUMERIC,
ADD COLUMN IF NOT EXISTS bonus_padrao NUMERIC,
ADD COLUMN IF NOT EXISTS ativa BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS observacoes TEXT;

UPDATE public.route_metrics_cache
SET tempo_estimado_horas = duracao_horas
WHERE tempo_estimado_horas IS NULL;
