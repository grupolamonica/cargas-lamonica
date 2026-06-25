-- Monitor unificado — enriquecimento (Angellira/ASPX) das cargas do SISTEMA.
--
-- sheet_monitor_enriched era keyed só por `lh` (LH da planilha). Cargas do
-- sistema (sheet_lh nulo) têm LH livre/vazio e nunca casavam → o selo ficava
-- "não consultado" para sempre. Passamos a gravar a linha enriquecida da carga
-- do sistema com lh = 'cargo:<uuid>' (prefixo reservado, não colide com LH real
-- da Shopee) E cargo_id preenchido, p/ o frontend casar por cargo_id.
--
-- Aditiva. Coluna nullable + índice único parcial (só onde cargo_id existe).

ALTER TABLE public.sheet_monitor_enriched ADD COLUMN IF NOT EXISTS cargo_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_enriched_cargo_id
  ON public.sheet_monitor_enriched (cargo_id)
  WHERE cargo_id IS NOT NULL;
