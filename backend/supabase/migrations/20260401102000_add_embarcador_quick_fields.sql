ALTER TABLE public.clientes
ADD COLUMN IF NOT EXISTS prazo_pagamento TEXT,
ADD COLUMN IF NOT EXISTS exige_rastreamento BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_antt BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_seguro BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS exige_carga_monitorada BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.clientes
DROP COLUMN IF EXISTS nome_fantasia;

DROP INDEX IF EXISTS idx_clientes_nome_fantasia;

UPDATE public.clientes
SET
  exige_rastreamento = exige_rastreamento OR COALESCE(NULLIF(BTRIM(rastreamento), ''), '') <> '',
  exige_antt = exige_antt OR COALESCE(NULLIF(BTRIM(antt), ''), '') <> '';
