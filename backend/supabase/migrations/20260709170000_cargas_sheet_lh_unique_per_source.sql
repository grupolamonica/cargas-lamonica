-- sheet_lh passa a ser único POR FONTE (sheet_source), não global.
--
-- No modelo multi-planilha, Shopee e Nestlé podem usar o MESMO código de carga
-- (Nº DE ORDEM / LH) sem colidir. O id do cargo já é namespaced por fonte
-- (createSheetLoadId(lh, source)), mas a UNIQUE global antiga em sheet_lh
-- (idx_cargas_sheet_lh) barrava a 2ª fonte quando um LH coincidia — ex.: uma
-- carga Nestlé "FK" batia numa carga Shopee "FK" antiga e o sync falhava (23505).
--
-- Usa COALESCE(sheet_source, '') para que cargas sem fonte (importação manual
-- legada) mantenham a unicidade por LH como antes. O upsert do sync é
-- onConflict:'id' (não depende deste índice).
--
-- Idempotente: seguro re-rodar.

DROP INDEX IF EXISTS public.idx_cargas_sheet_lh;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cargas_source_sheet_lh
  ON public.cargas (COALESCE(sheet_source, ''), sheet_lh)
  WHERE sheet_lh IS NOT NULL AND sheet_lh <> '';
