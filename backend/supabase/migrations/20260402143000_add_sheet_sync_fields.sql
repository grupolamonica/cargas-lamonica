ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS sheet_lh TEXT,
ADD COLUMN IF NOT EXISTS sheet_tipo TEXT,
ADD COLUMN IF NOT EXISTS sheet_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cargas_sheet_lh
ON public.cargas (sheet_lh)
WHERE sheet_lh IS NOT NULL AND sheet_lh <> '';
