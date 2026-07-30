-- RLS habilitada SEM policy em angellira_conformity_overrides: nega
-- anon/authenticated (PostgREST), enquanto o backend conecta como `postgres` e
-- bypassa a RLS (mesmo padrão das demais tabelas operacionais do projeto). A
-- tabela guarda CPF do motorista + observação livre (PII), então NÃO pode ficar
-- exposta pela anon key. Corrige o lint 0013_rls_disabled_in_public.
ALTER TABLE public.angellira_conformity_overrides ENABLE ROW LEVEL SECURITY;
