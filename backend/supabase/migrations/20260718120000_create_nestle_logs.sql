-- nestle_logs — log de execução do coletor Galileu (robo_coleta / robo_embarques).
-- OPCIONAL para a tela Programação: o coletor (registrar_log) é tolerante e segue
-- funcionando sem a tabela. Existe só para o coletor gravar seus próprios logs de
-- ciclo e evitar o WARN recorrente "nestle_logs ausente no destino" (PGRST205).
-- Colunas espelham bots/galileu/nestle/supabase_client.py::registrar_log.
CREATE TABLE IF NOT EXISTS public.nestle_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nivel       text,
  mensagem    text,
  detalhes    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nestle_logs_created ON public.nestle_logs (created_at DESC);

-- RLS ligada sem policy (consistente com nestle_ofertas/embarques): o coletor grava
-- via service_role (bypassa RLS); nada é exposto ao anon via PostgREST.
ALTER TABLE public.nestle_logs ENABLE ROW LEVEL SECURITY;
