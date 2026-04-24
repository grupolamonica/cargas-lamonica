-- driver_portal_visits: registros de acesso anônimo ao portal público do motorista.
-- Serve de base para o "Pico de acesso" no dashboard do operador.
CREATE TABLE IF NOT EXISTS public.driver_portal_visits (
  id bigserial PRIMARY KEY,
  visited_at timestamptz NOT NULL DEFAULT now(),
  request_ip text,
  correlation_id text
);

CREATE INDEX IF NOT EXISTS idx_driver_portal_visits_at
  ON public.driver_portal_visits (visited_at DESC);

-- Sem RLS aberta — apenas service role (backend) insere/lê.
ALTER TABLE public.driver_portal_visits ENABLE ROW LEVEL SECURITY;
