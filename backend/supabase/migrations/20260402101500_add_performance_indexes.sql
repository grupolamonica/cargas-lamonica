CREATE INDEX IF NOT EXISTS idx_cargas_created_at
ON public.cargas (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cargas_origem_destino_created_at
ON public.cargas (origem, destino, created_at DESC)
WHERE distancia_km IS NOT NULL AND duracao_horas IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_created_at
ON public.clientes (created_at DESC);
