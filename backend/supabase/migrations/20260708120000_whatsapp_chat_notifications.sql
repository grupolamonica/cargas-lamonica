-- driver-outreach / WhatsApp chat + notificações do operador (2026-07-08).
--
-- Duas tabelas de suporte, ambas backend-only (backend escreve, operador lê via
-- RLS, espelhando driver_outreach_optout / driver_outreach_log):
--   * whatsapp_messages         — histórico de mensagens IN/OUT (chat do operador).
--   * operator_notifications    — sino do menu do operador (reserva expirada, etc.).
--
-- Idempotente: CREATE ... IF NOT EXISTS.

-- ── WhatsApp messages ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance       text        NOT NULL,          -- instância Evolution (multi-número)
  direction      text        NOT NULL,          -- 'in' | 'out'
  external_id    text,                          -- key.id do Evolution/Baileys (dedupe)
  phone          text        NOT NULL,          -- telefone normalizado (dígitos DDI 55)
  driver_key     text,                          -- CPF normalizado, se conhecido
  text           text        NOT NULL DEFAULT '',
  message_type   text        NOT NULL DEFAULT 'text',  -- text | image | audio | etc.
  status         text        NOT NULL DEFAULT 'received',  -- received (in) | sent | delivered | read | failed (out)
  timestamp      timestamptz NOT NULL DEFAULT now(),
  raw            jsonb       NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_messages_direction_chk CHECK (direction IN ('in', 'out')),
  CONSTRAINT whatsapp_messages_status_chk CHECK (
    status IN ('received', 'sent', 'delivered', 'read', 'failed', 'pending')
  )
);

-- Dedupe por external_id (Evolution reenvia webhooks em retry).
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_messages_external_id
  ON public.whatsapp_messages (instance, external_id)
  WHERE external_id IS NOT NULL;

-- Consulta de chat por conversa (phone/driver_key).
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_ts
  ON public.whatsapp_messages (phone, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_driver_ts
  ON public.whatsapp_messages (driver_key, timestamp DESC)
  WHERE driver_key IS NOT NULL;

-- ── Operator notifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.operator_notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text        NOT NULL,          -- 'reservation_timeout' | 'driver_reply_accept' | 'driver_reply_reject' | 'driver_reply' | ...
  title         text        NOT NULL,
  body          text        NOT NULL DEFAULT '',
  metadata      jsonb       NOT NULL DEFAULT '{}',
  seen          boolean     NOT NULL DEFAULT false,
  seen_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_notifications_unseen
  ON public.operator_notifications (created_at DESC)
  WHERE seen = false;

-- ── RLS (espelha driver_outreach_log: operador lê; backend é dono e escreve) ──
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view whatsapp messages" ON public.whatsapp_messages;
CREATE POLICY "Operators can view whatsapp messages"
  ON public.whatsapp_messages
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');

ALTER TABLE public.operator_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view operator notifications" ON public.operator_notifications;
CREATE POLICY "Operators can view operator notifications"
  ON public.operator_notifications
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
