-- Cria a sequence usada para gerar o protocolo de candidatura (cadastro v2).
--
-- Contexto: `submit-final.js` (mintProtocolo) chama
--   nextval('public.cadastro_protocolo_seq')
-- para montar o protocolo no formato `YYYY-NNNNN`. A sequence havia sido criada
-- manualmente apenas em staging (oklksqv), nunca versionada — então produção
-- (lbpzkdec) ficou sem ela e todo submit-final lançava
--   "sequence cadastro_protocolo_seq ausente ou inacessivel" (HTTP 500).
--
-- Esta migration torna a criação reprodutível e idempotente para qualquer
-- ambiente. Os grants espelham o estado de staging (USAGE para os roles
-- Supabase) — o backend conecta como `postgres` (owner), mas mantemos os grants
-- por consistência caso o nextval seja chamado sob outro role no futuro.

CREATE SEQUENCE IF NOT EXISTS public.cadastro_protocolo_seq;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.cadastro_protocolo_seq
  TO authenticated, anon, service_role;
