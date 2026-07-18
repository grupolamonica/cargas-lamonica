-- driver-outreach — configurações CONTROLÁVEIS pela tela do operador (Wave B/C).
--
-- Singleton (id=1). O worker/scanner leem esta linha a cada ciclo, então o
-- operador liga/desliga e ajusta cap/horário sem redeploy. As env vars
-- (DRIVER_OUTREACH_*) viram apenas fallback quando esta tabela não existe.

CREATE TABLE IF NOT EXISTS public.driver_outreach_settings (
  id               smallint    PRIMARY KEY DEFAULT 1,
  enabled          boolean     NOT NULL DEFAULT false,   -- kill-switch geral do envio automático
  cold_enabled     boolean     NOT NULL DEFAULT false,   -- libera gatilhos frios (churn/retorno)
  daily_cap        int         NOT NULL DEFAULT 50,
  quiet_start_hour int         NOT NULL DEFAULT 8,        -- BRT — só envia a partir daqui
  quiet_end_hour   int         NOT NULL DEFAULT 20,       -- BRT — para de enviar a partir daqui
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT driver_outreach_settings_singleton CHECK (id = 1)
);

-- Linha default (desligado). Idempotente.
INSERT INTO public.driver_outreach_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.driver_outreach_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view driver outreach settings" ON public.driver_outreach_settings;
CREATE POLICY "Operators can view driver outreach settings"
  ON public.driver_outreach_settings
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
