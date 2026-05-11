-- Adds two additional logo slots per client:
--   logo_url_card     → logo shown in the LoadCard (driver "cargas disponíveis" list)
--   logo_url_proximas → logo shown in CargasProximasCard (driver "cargas próximas" section)
-- The existing logo_url column continues to be used on the client detail page.

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS logo_url_card     TEXT,
  ADD COLUMN IF NOT EXISTS logo_url_proximas TEXT;
