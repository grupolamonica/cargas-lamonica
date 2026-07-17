-- Central de controle das mensagens automáticas (driver-outreach).
-- O operador edita o texto (com variáveis {nome}, {rota}, {detalhes}, {link}) e
-- liga/desliga cada tipo de mensagem na tela de Mensagens. O código traz um
-- default para cada `key`; esta tabela guarda apenas os OVERRIDES do operador.
-- Bloco de detalhes da carga (📍📅💰 + aviso do bônus) é montado pelo sistema
-- e injetado onde estiver {detalhes}.

CREATE TABLE IF NOT EXISTS public.driver_outreach_message_templates (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  template   text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.driver_outreach_message_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators manage message templates" ON public.driver_outreach_message_templates;
CREATE POLICY "Operators manage message templates"
  ON public.driver_outreach_message_templates
  FOR SELECT TO authenticated
  USING (public.current_app_role() = 'operator');
