-- Monitor — "Check Rodopar" (DC-260) por LH, DESACOPLADO de cargas.
--
-- Por que não em cargas: o Monitor (/planilha) é um SNAPSHOT da planilha Google
-- (~6343 linhas), mas só ~1500 têm carga em `cargas` (via sync). Gravar rodopar em
-- cargas por createSheetLoadId(lh) falhava ("Carga não encontrada") na maioria das
-- linhas, e criar uma carga só p/ guardar o flag poluiria o portal do motorista.
-- Esta tabela guarda o estado por LH da linha do Monitor, exista carga ou não.
--
-- status: 0 = não lançado (vermelho, default) · 1 = lançado (preto) · 2 = lançado
-- incorreto/incompleto (azul). Aditiva e idempotente.
CREATE TABLE IF NOT EXISTS public.monitor_rodopar_status (
  lh         text PRIMARY KEY,
  status     smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- RLS ligada sem policy (padrão do projeto): o backend acessa como postgres/
-- service_role (bypassa RLS); nada exposto ao anon via PostgREST.
ALTER TABLE public.monitor_rodopar_status ENABLE ROW LEVEL SECURITY;
