-- Tabela de veiculos descobertos via lookups Angellira durante validacao de leads.
-- Cada placa mapeia para exatamente uma linha (upsert via ON CONFLICT).

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Placa normalizada (uppercase, sem hifen/espacos). Chave natural unica.
  plate text NOT NULL,

  -- Classificacao do veiculo (CARRETA, TRUCK, BITREM, etc.)
  vehicle_type text,

  -- Papel da placa no conjunto: HORSE (cavalo), TRAILER_1 (carreta), TRAILER_2 (2a carreta)
  plate_role text NOT NULL DEFAULT 'HORSE',

  -- Resultados do lookup Angellira
  angellira_status text,                -- FOUND | NOT_FOUND | UNAVAILABLE
  angellira_valid_until date,           -- Data de vigencia
  angellira_status_text text,           -- Ex: "Conforme", "Nao Conforme"
  angellira_display_name text,          -- Nome do motorista retornado pelo Angellira
  angellira_last_seen_at timestamptz,   -- sentDate do Angellira
  angellira_checked_at timestamptz,     -- Quando foi consultado pela ultima vez

  -- Vinculo com motorista que submeteu essa placa
  linked_driver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  linked_driver_cpf text,

  -- Origem do registro
  source text NOT NULL DEFAULT 'PUBLIC_LEAD',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_vehicles_plate ON public.vehicles (plate);

CREATE INDEX idx_vehicles_angellira_vigency
  ON public.vehicles (angellira_valid_until)
  WHERE angellira_valid_until IS NOT NULL;

CREATE INDEX idx_vehicles_linked_driver
  ON public.vehicles (linked_driver_id)
  WHERE linked_driver_id IS NOT NULL;
