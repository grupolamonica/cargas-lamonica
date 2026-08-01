-- Rastro da "aposentadoria de gêmea" do sync da planilha.
--
-- Contexto (caso LT0Q8102CH2U1): a mesma viagem existe como DUAS cargas — a lançada pela
-- Programação (lh_manual) e a da planilha (sheet_lh, id determinístico sha1("sheet-load:LH")).
-- O sync aposenta a lançada marcando status='EXPIRED', mas sem dizer POR QUE nem QUEM passou
-- a valer: a lápide fica indistinguível de uma expiração comum por horário. Para investigar
-- o caso foi preciso reconstruir o evento por updated_at em lote.
--
-- superseded_by_cargo_id — id da carga CANÔNICA (linha da planilha) que substituiu esta
-- retired_reason        — 'twin_taken' | 'twin_open_duplicate' | 'twin_superseded_on_create'
--
-- Aditivas e idempotentes; NULL = carga nunca aposentada como gêmea (inclusive todas as
-- lápides antigas, que continuam NULL até um backfill explícito).
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS superseded_by_cargo_id UUID;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS retired_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_cargas_superseded_by
  ON public.cargas (superseded_by_cargo_id)
  WHERE superseded_by_cargo_id IS NOT NULL;
