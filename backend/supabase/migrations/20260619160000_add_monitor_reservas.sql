-- Monitor — motoristas em RESERVA (standby) por rota.
--
-- Quando uma carga é cancelada, a cascata (Interpretação A) faz o motorista descer
-- a fila da rota; quem fica sem carga vira "reserva". Como essa linha NÃO existe na
-- planilha (não tem LH), ela vive aqui — uma fila de standby por rota, exibida no
-- Monitor como linha RESERVA. O read model (service-role) injeta essas linhas.
--
-- Idempotente: CREATE ... IF NOT EXISTS. RLS espelha sheet_monitor_snapshot
-- (operador lê; a conexão direta do backend é dona da tabela e escreve).

CREATE TABLE IF NOT EXISTS public.monitor_reservas (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  motorista   text        NOT NULL DEFAULT '',
  cavalo      text        NOT NULL DEFAULT '',
  carreta     text        NOT NULL DEFAULT '',
  origem      text        NOT NULL DEFAULT '',
  destino     text        NOT NULL DEFAULT '',
  route_key   text        NOT NULL DEFAULT '',   -- "origem→destino" (agrupa por rota)
  origin_lh   text,                              -- LH da carga cancelada que gerou a reserva
  status      text        NOT NULL DEFAULT 'RESERVA',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Leitura/listagem por rota só das reservas ativas.
CREATE INDEX IF NOT EXISTS idx_monitor_reservas_active
  ON public.monitor_reservas (route_key) WHERE active;

ALTER TABLE public.monitor_reservas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view monitor reservas" ON public.monitor_reservas;
CREATE POLICY "Operators can view monitor reservas"
  ON public.monitor_reservas
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
