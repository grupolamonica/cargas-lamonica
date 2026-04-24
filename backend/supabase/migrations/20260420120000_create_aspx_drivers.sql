-- Registro de motoristas vindos do Agency Portal (ASPx / myagencyservice).
-- Presença nesta tabela significa "tem ASPx = SIM"; ausência = NÃO.
-- Populada a cada 1h por GitHub Action (scripts/aspx-sync/asp.py) via login
-- no portal real. Substitui a planilha Google Sheets "API Spx" como fonte
-- de verdade consumida pelo backend de validação de candidaturas.

CREATE TABLE public.aspx_drivers (
  cpf           TEXT PRIMARY KEY,          -- CPF normalizado (apenas dígitos)
  display_name  TEXT,
  raw_status    TEXT,                      -- status bruto retornado pelo portal
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aspx_drivers_last_seen ON public.aspx_drivers (last_seen_at DESC);

ALTER TABLE public.aspx_drivers ENABLE ROW LEVEL SECURITY;

-- Apenas service-role (backend / job) lê/escreve. authenticated não tem acesso.
CREATE POLICY "service role manages aspx_drivers"
ON public.aspx_drivers
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

-- Credenciais de acesso ao Agency Portal armazenadas no banco para que o
-- GitHub Action puxe no runtime sem precisar de um secret separado por
-- credencial. Singleton (id = 1). Apenas service-role acessa.
CREATE TABLE public.aspx_credentials (
  id         SMALLINT PRIMARY KEY DEFAULT 1,
  email      TEXT NOT NULL,
  password   TEXT NOT NULL,
  device_id  TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT aspx_credentials_singleton CHECK (id = 1)
);

ALTER TABLE public.aspx_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages aspx_credentials"
ON public.aspx_credentials
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

-- Seed inicial (pode ser rotacionado via UPDATE manualmente).
INSERT INTO public.aspx_credentials (id, email, password, device_id)
VALUES (
  1,
  'cynthia.rios@grupolamonica.com.br',
  'Lamonica@2024',
  'e17e5dcd53c211d038a0cd1a950702df'
)
ON CONFLICT (id) DO NOTHING;
