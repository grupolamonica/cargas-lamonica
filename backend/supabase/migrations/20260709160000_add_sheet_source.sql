-- Multi-sheet load sync: distinguish which Google Sheet a carga came from.
--
-- Até aqui o sync de planilha assumia uma única fonte (Shopee). Para puxar
-- cargas de MÚLTIPLAS planilhas (Shopee + Nestlé) sem que um sync expire/limpe
-- as cargas do outro, cada carga vinda de planilha passa a carregar a fonte
-- (`sheet_source`). A limpeza de cargas obsoletas (EXPIRE OPEN→EXPIRED e o
-- null-out de sheet_*) é escopada por `sheet_source`, então um sync da Nestlé
-- nunca toca cargas da Shopee e vice-versa.
--
-- Idempotente: seguro re-rodar.

-- 1. cargas.sheet_source — qual planilha originou a carga (NULL = manual / legado).
ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS sheet_source text;

-- Backfill: toda carga que já veio de planilha (tem sheet_lh) é da Shopee, a
-- única fonte que existia antes desta migration.
UPDATE public.cargas
  SET sheet_source = 'shopee'
  WHERE sheet_lh IS NOT NULL
    AND sheet_source IS NULL;

-- Índice parcial para o sync escopar rapidamente por fonte (fetchExistingSheetLoads
-- + os UPDATEs de limpeza filtram por sheet_source).
CREATE INDEX IF NOT EXISTS idx_cargas_sheet_source
  ON public.cargas (sheet_source)
  WHERE sheet_source IS NOT NULL;

-- 2. sheet_monitor_snapshot: passa de singleton (id=1) para 1 linha por fonte.
--
-- A tabela nasceu como singleton (PK smallint + CHECK id=1). Para armazenar um
-- snapshot por planilha sem quebrar a linha da Shopee (id=1, byte-compatível
-- com hoje), adicionamos a coluna `source`, removemos a trava de singleton e
-- passamos a chavear os upserts por `source` (UNIQUE). Esquema escolhido:
--   - Shopee → id=1, source='shopee'  (INALTERADO — o upsert continua id=1)
--   - Nestlé → source='nestle'         (id gerado; a chave de conflito é source)
ALTER TABLE public.sheet_monitor_snapshot
  ADD COLUMN IF NOT EXISTS source text;

-- Backfill da linha singleton existente para 'shopee'.
UPDATE public.sheet_monitor_snapshot
  SET source = 'shopee'
  WHERE source IS NULL;

-- Remove a trava de singleton (id=1) — agora há mais de uma linha (uma por fonte).
ALTER TABLE public.sheet_monitor_snapshot
  DROP CONSTRAINT IF EXISTS sheet_monitor_snapshot_singleton;

-- `id` deixa de ser o discriminador de fonte; novas linhas precisam de um id
-- próprio. Como a coluna nasceu smallint sem sequence, geramos o id no app para
-- fontes != shopee (shopee continua fixo em id=1). Garantimos unicidade de fonte.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sheet_monitor_snapshot_source
  ON public.sheet_monitor_snapshot (source);
