-- Monitor — alocação FIXA ("fixo"): trava o motorista/veículo numa carga.
--
-- Quando o operador "fixa" uma carga, o motorista+veículo daquela linha não pode
-- mais ser movido — nem arrastando (reassign), nem editando inline/modal, nem
-- pela cascata de cancelamento da rota. É a decisão do operador de que aquele
-- motorista está garantido naquela viagem.
--
-- Aditiva e idempotente (segue o padrão das migrations add_alloc_* / add_sheet_*).
-- NOT NULL DEFAULT false: em Postgres 11+ a coluna com default constante é
-- metadata-only (sem rewrite da tabela). O SYNC da planilha NUNCA toca alloc_*,
-- então o "fixo" é durável.

ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_pinned_at TIMESTAMPTZ;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_pinned_by UUID;
