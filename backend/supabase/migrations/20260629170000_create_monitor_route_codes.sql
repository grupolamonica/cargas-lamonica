-- Código sequencial ESTÁVEL por rota (origem→destino) exibido na fila/Monitor do
-- operador. Atribuído sob demanda por route-codes.js (attachRouteCodes): a rota
-- ganha um `codigo` (IDENTITY) na primeira vez que aparece e o reusa depois.
--
-- Estava só no staging (criada ad-hoc) — sem migration no repo. Sem esta tabela,
-- attachRouteCodes degrada (best-effort try/catch: Monitor abre, mas sem código de
-- rota) e a migration de mojibake (que faz DELETE aqui) falharia. Idempotente.
--
-- Backend-only: lida/escrita pelo backend via service_role (mesmo padrão de
-- driver_vinculos / aspx_drivers). PK composta (origin_key, destination_key) —
-- casa com o onConflict do upsert em route-codes.js.

CREATE TABLE IF NOT EXISTS public.monitor_route_codes (
  origin_key      TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  codigo          BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_key, destination_key)
);

ALTER TABLE public.monitor_route_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages monitor_route_codes" ON public.monitor_route_codes;
CREATE POLICY "service role manages monitor_route_codes"
ON public.monitor_route_codes
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);
