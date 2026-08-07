-- UNICIDADE REAL do LH da carga LANÇADA (Programação), entre as linhas VIVAS.
--
-- PROBLEMA: o dedup do lançamento é best-effort — `launch-cargo-from-trip.js` faz
-- SELECT ("já existe carga com este LH?") e depois INSERT, em statements separados.
-- Dois cliques simultâneos (ou duas passadas do auto-lançamento) passam os dois pelo
-- SELECT e inserem os dois: duas cargas do sistema com o MESMO lh_manual, que o
-- Monitor exibe como duas linhas da mesma viagem. Nada no banco impedia isso —
-- `idx_cargas_lh_manual` (20260721190000) é um índice comum, não único.
--
-- ESCOPO DELIBERADO: este índice cobre APENAS a carga lançada viva. Ele NÃO tenta
-- unificar o LH entre `lh_manual` e `sheet_lh` (um índice em
-- COALESCE(sheet_lh, lh_manual) seria o desejo natural, mas MATA o sync):
--
--   o sync (`google-sheet-loads.js`) INSERE a linha canônica da planilha (sheet_lh)
--   ENQUANTO a carga lançada (lh_manual) do mesmo LH ainda está viva — e é justamente
--   essa coexistência que TORNA LEGAL a aposentadoria da gêmea, que roda depois, no
--   mesmo ciclo (upsert na fase 7, aposentadoria na fase 17). Com um índice
--   cross-coluna, o upsert da fase 7 levantaria 23505, o `throw` aborta a rodada
--   inteira e a fonte morre a cada 5 min — exatamente o modo de falha documentado em
--   `merge-launched-twin.js:10-15`. Medido em 07/08/2026: a duplicação que o operador
--   VÊ é a lápide da gêmea (271 linhas) e se resolve na LEITURA, não com constraint.
--
-- NAMESPACE POR FONTE, igual a `idx_cargas_source_sheet_lh` (20260709170000): Shopee e
-- Nestlé podem usar o MESMO código de carga, e há LH repetido entre as duas em
-- produção (ver o comentário do INSERT em `launch-cargo-from-trip.js`). Sem o
-- namespace, lançar a oferta Nestlé "FK" seria barrado por uma carga Shopee "FK".
--
-- LÁPIDE FORA DO ÍNDICE (`retired_reason` / `alloc_merged_into_cargo_id`): a gêmea
-- aposentada CONSERVA o `lh_manual` de propósito — é o gate anti-duplo-lançamento e a
-- doadora legítima de `promote-launched-twins.js` (a porta de mão única do PR #442).
-- Ela sai do índice, não do banco: o SELECT de dedup do lançamento continua achando-a
-- e devolvendo `alreadyExists`, então relançar segue bloqueado como hoje.
--
-- CRIÁVEL HOJE: medido em produção 07/08/2026 — 0 (zero) colisões de `lh_manual`
-- entre lançadas vivas. O índice nasce sem precisar de limpeza de dados.
--
-- Tabela pequena → CREATE INDEX simples (lock ACCESS EXCLUSIVE breve, mesmo
-- precedente de 20260721190000). Aditiva e idempotente: seguro re-rodar.

CREATE UNIQUE INDEX IF NOT EXISTS ux_cargas_source_lh_manual_live
  ON public.cargas (COALESCE(sheet_source, ''), lh_manual)
  WHERE sheet_lh IS NULL
    AND lh_manual IS NOT NULL
    AND lh_manual <> ''
    AND COALESCE(is_template, false) = false
    AND retired_reason IS NULL
    AND alloc_merged_into_cargo_id IS NULL;

COMMENT ON INDEX public.ux_cargas_source_lh_manual_live IS
  'Uma carga lancada VIVA por (fonte, LH). Lapide (retired_reason/alloc_merged_into_cargo_id) fica fora: conserva lh_manual como gate anti-duplo-lancamento. Nao cobre sheet_lh — indice cross-coluna quebraria o upsert do sync.';
