-- Programação — configurações controláveis pela tela do operador (DC-201).
--
-- Singleton (id=1). O scanner de auto-lançamento (main.js) lê esta linha a cada
-- ciclo, então o operador liga/desliga o lançamento automático de spots com rota
-- sem redeploy. A env SPOT_AUTOLAUNCH_ENABLED=false continua sendo um kill-switch
-- de infraestrutura acima disto (se setada, força desligado independente da linha).
-- Default LIGADO (é o core da feature).

CREATE TABLE IF NOT EXISTS public.programacao_settings (
  id                       smallint    PRIMARY KEY DEFAULT 1,
  spot_autolaunch_enabled  boolean     NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid,
  CONSTRAINT programacao_settings_singleton CHECK (id = 1)
);

-- Linha default (ligado). Idempotente.
INSERT INTO public.programacao_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.programacao_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view programacao settings" ON public.programacao_settings;
CREATE POLICY "Operators can view programacao settings"
  ON public.programacao_settings
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
