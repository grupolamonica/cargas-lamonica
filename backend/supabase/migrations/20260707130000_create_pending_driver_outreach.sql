-- driver-outreach — fila de ENVIO assíncrono (Wave B).
--
-- O worker (application/driver-outreach/outreach-worker.js) drena esta fila e
-- envia via Evolution API. Idempotência por (driver_key, trigger) — não
-- re-enfileira a mesma oportunidade. Backend-only (RLS: operador só lê).
--
-- Envio fica DESLIGADO por padrão (DRIVER_OUTREACH_ENABLED != 'true'); esta
-- tabela pode existir sem nenhum envio acontecer.

CREATE TABLE IF NOT EXISTS public.pending_driver_outreach (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_key      text        NOT NULL,           -- CPF (dígitos) ou nome normalizado
  trigger         text        NOT NULL,           -- churn | lost_registration | abandonment | return_load
  phone           text        NOT NULL,           -- telefone normalizado (DDI 55)
  message         text        NOT NULL,           -- mensagem já composta
  status          text        NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  retry_count     int         NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT pending_driver_outreach_status_chk CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT pending_driver_outreach_uniq UNIQUE (driver_key, trigger)
);

-- Índice de drenagem: pega os pendentes prontos para tentativa, mais antigos primeiro.
CREATE INDEX IF NOT EXISTS idx_pending_driver_outreach_drain
  ON public.pending_driver_outreach (status, next_attempt_at, created_at)
  WHERE status = 'pending';

ALTER TABLE public.pending_driver_outreach ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view pending driver outreach" ON public.pending_driver_outreach;
CREATE POLICY "Operators can view pending driver outreach"
  ON public.pending_driver_outreach
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
