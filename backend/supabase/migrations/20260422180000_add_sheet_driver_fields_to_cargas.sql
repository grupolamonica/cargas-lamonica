-- Add sheet-sourced driver/vehicle fields to cargas.
-- Populated during Google Sheets sync and preserved even when the sheet row
-- is later removed (stale cleanup). This ensures history screens always
-- show who drove each cargo and which truck was used.

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS sheet_motorista TEXT,
  ADD COLUMN IF NOT EXISTS sheet_cavalo    TEXT,
  ADD COLUMN IF NOT EXISTS sheet_carreta   TEXT;
