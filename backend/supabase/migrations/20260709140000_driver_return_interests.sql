-- Fila de interesse do motorista quando não há carga imediata na rota.
-- Quando o motorista responde interessado ("sim") a um envio sem carga OPEN
-- disponível, guardamos o interesse aqui; assim que uma carga OPEN da mesma
-- rota (origem/destino) surgir no sistema, o job dispara notificação para ele.
--
-- TTL padrão: 7 dias (expires_at). Idempotente por (driver_key, origem, destino).

CREATE TABLE IF NOT EXISTS public.driver_return_interests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_key    text        NOT NULL,          -- CPF (dígitos) ou nome normalizado
  phone         text        NOT NULL,
  nome          text,
  origem        text,
  destino       text,
  rota          text,
  source        text        NOT NULL,          -- mass_no_load | reject_ack | orphan_accept | manual
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  matched_at    timestamptz,
  matched_load_id uuid,
  CONSTRAINT driver_return_interests_source_chk CHECK (source IN ('mass_no_load','reject_ack','orphan_accept','manual'))
);

CREATE INDEX IF NOT EXISTS idx_driver_return_interests_active
  ON public.driver_return_interests (origem, destino)
  WHERE matched_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_return_interests_driver
  ON public.driver_return_interests (driver_key, created_at DESC);

ALTER TABLE public.driver_return_interests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view return interests" ON public.driver_return_interests;
CREATE POLICY "Operators can view return interests"
  ON public.driver_return_interests
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
