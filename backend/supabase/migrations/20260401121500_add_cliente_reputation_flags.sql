ALTER TABLE public.clientes
ADD COLUMN IF NOT EXISTS reputacao_pagamento_rapido BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_bom_pagador BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_liberacao_rapida BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_carga_organizada BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS reputacao_boa_comunicacao BOOLEAN NOT NULL DEFAULT false;
