ALTER TABLE public.load_public_leads
  ADD COLUMN IF NOT EXISTS pii_redacted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_load_public_leads_pii_redacted_at
ON public.load_public_leads (pii_redacted_at, approved_at, updated_at)
WHERE pii_redacted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.security_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role text,
  resource_type text,
  resource_id text,
  action text,
  outcome text NOT NULL,
  request_ip text,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_event_created_at
ON public.security_audit_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_audit_logs_actor_created_at
ON public.security_audit_logs (actor_user_id, created_at DESC);

ALTER TABLE public.security_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view security audit logs" ON public.security_audit_logs;

CREATE POLICY "Operators can view security audit logs"
ON public.security_audit_logs
FOR SELECT
TO authenticated
USING (public.current_app_role() = 'operator');
