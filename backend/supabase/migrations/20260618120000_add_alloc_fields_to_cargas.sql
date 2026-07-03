-- Monitor editável (Fase 0): alocação como DECISÃO do operador, dona do sistema.
--
-- Hoje a alocação (motorista/cavalo/carreta/status operacional) é digitada pelo
-- operador na planilha e o sync a lê de volta em cargas.sheet_*. Para abandonar
-- a planilha, a decisão do operador passa a ser editada NO sistema (tela
-- Monitor) e guardada em colunas próprias `alloc_*` que o SYNC NUNCA sobrescreve.
--
-- Leitura "alocação efetiva" por campo = COALESCE(alloc_*, sheet_*): enquanto a
-- planilha existir, ela preenche sheet_*; o operador sobrepõe via alloc_*. Assim
-- as duas fontes coexistem sem o sync apagar a edição do operador.
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS) — segue o padrão das
-- migrations add_sheet_* / add_recurrence. Sem backfill: NULL = "sem override".

ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_motorista TEXT;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_cavalo TEXT;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_carreta TEXT;

-- Status OPERACIONAL (mesmo domínio livre de sheet_status: DESCARREGADO,
-- CTE ENVIADO, AGUARDANDO DESCARGA, etc.) — NÃO é o enum de lifecycle cargas.status.
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_status TEXT;

-- Procedência da alocação efetiva ('operator' nesta fase; 'spx' na Fase 1+).
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_source TEXT;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_updated_at TIMESTAMPTZ;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_updated_by UUID;
