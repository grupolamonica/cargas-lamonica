-- Singleton table for caching the sheet monitor snapshot.
-- id is always 1 (enforced by CHECK constraint).
-- Rows are upserted on every Google Sheets sync so reads are instant.
--
-- This migration is idempotent: safe to re-run if partially applied.

CREATE TABLE IF NOT EXISTS public.sheet_monitor_snapshot (
  id       smallint    PRIMARY KEY DEFAULT 1,
  rows_json    jsonb   NOT NULL DEFAULT '[]'::jsonb,
  summary_json jsonb   NOT NULL DEFAULT '{}'::jsonb,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sheet_monitor_snapshot_singleton CHECK (id = 1)
);

ALTER TABLE public.sheet_monitor_snapshot ENABLE ROW LEVEL SECURITY;

-- Operators may read the snapshot; service-role bypasses RLS for writes.
DROP POLICY IF EXISTS "Operators can view sheet monitor snapshot"
  ON public.sheet_monitor_snapshot;

CREATE POLICY "Operators can view sheet monitor snapshot"
  ON public.sheet_monitor_snapshot
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
