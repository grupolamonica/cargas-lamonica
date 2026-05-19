-- Sheet sync jobs table — tracks async Google Sheets sync requests.
-- Workers poll for pending/running jobs and update status when done.
CREATE TABLE IF NOT EXISTS public.sheet_sync_jobs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID       NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed')),
  result     JSONB,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_jobs_status
  ON public.sheet_sync_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sheet_sync_jobs_operator
  ON public.sheet_sync_jobs (operator_id, created_at DESC);
