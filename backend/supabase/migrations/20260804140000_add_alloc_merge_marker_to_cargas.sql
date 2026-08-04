-- Marcador de MERGE da gêmea (carga lançada → carga da planilha).
--
-- Uma mesma viagem SPX existe hoje como DUAS cargas: a linha da planilha
-- (sheet_lh, id determinístico) e a carga lançada pela Programação (lh_manual,
-- sheet_lh NULL). Essa duplicidade é a causa raiz de uma família de defeitos
-- (write-back na chave errada, duplicação no Monitor, assign na linha vazia,
-- status congelado, regressão do CTE na planilha).
--
-- A unificação move os `alloc_*` (a decisão do operador) da carga lançada para a
-- carga da planilha, que passa a ser a ÚNICA alvo de escrita. A carga lançada
-- NUNCA é apagada (as FKs de lead/evento são ON DELETE CASCADE e ela é a
-- pré-imagem do rollback) e NUNCA tem `lh_manual` limpo (é o gate
-- anti-duplo-lançamento da Programação): ela recebe este marcador.
--
-- Por que coluna PRÓPRIA e não reuso de `retired_reason`/`superseded_by_cargo_id`:
--   * `retired_reason` (migration 20260801130000) nasceu sem backfill — centenas de
--     lançadas EXPIRED antigas têm NULL, então ele NÃO discrimina "lápide";
--   * `superseded_by_cargo_id` já é escrito pelo CTE de aposentadoria do sync com
--     outra semântica (e em quase toda `twin_taken` fica NULL).
-- Coluna própria mantém todos os predicados novos como NO-OP no deploy (tudo NULL
-- até o gate TWIN_MERGE ser ligado), que é o que permite quebrar em PRs pequenos.
--
-- Aditiva: sem DEFAULT, sem NOT NULL, sem índice, sem backfill.

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS alloc_merged_into_cargo_id uuid,
  ADD COLUMN IF NOT EXISTS alloc_merged_at timestamptz;

COMMENT ON COLUMN public.cargas.alloc_merged_into_cargo_id IS
  'Carga canônica (da planilha) que herdou os alloc_* desta carga lançada. Marcador de MERGE — não é aposentadoria (ver retired_reason).';
COMMENT ON COLUMN public.cargas.alloc_merged_at IS
  'Quando os alloc_* desta carga lançada foram herdados pela canônica.';
