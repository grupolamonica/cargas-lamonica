-- Cofre DC-236: credenciais do rastreador POR CAVALO (placa do cavalo = PK).
-- Espelha o padrão service-role-only + RLS de brk_credentials/aspx_credentials,
-- mas a SENHA fica CIFRADA em repouso via pgcrypto (pgp_sym_encrypt). A chave de
-- cifra NUNCA fica no banco: vem do backend (env RASTREADOR_VAULT_KEY) e é passada
-- como PARÂMETRO ($n) nas queries do use-case — jamais como literal no SQL.
-- Base: análise DC-223 + PainelGR §07 (BaseRatreador) / §10 (mover credenciais p/ cofre).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.rastreador_credentials (
  horse_plate     text PRIMARY KEY,                 -- placa do CAVALO (normalizada, uppercase, sem hífen)
  provider        text NOT NULL DEFAULT '',          -- Sascar / Omnilink / Autotrac / ...
  username        text NOT NULL DEFAULT '',
  password_cipher bytea,                             -- pgp_sym_encrypt(senha, :key). NUNCA texto puro.
  notes           text,
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rastreador_credentials ENABLE ROW LEVEL SECURITY;

-- Apenas service-role (backend). authenticated/anon NÃO recebem policy => sem acesso
-- via PostgREST. A autorização real do operador é no handler (assertOperatorAccessLevel
-- 'advanced'); a RLS aqui fecha a porta do PostgREST, não do pool pg (que usa postgres/BYPASSRLS).
CREATE POLICY "service role manages rastreador_credentials"
ON public.rastreador_credentials
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

COMMENT ON TABLE public.rastreador_credentials IS
  'Cofre DC-236: credenciais do rastreador por placa de cavalo. Senha cifrada com pgcrypto (chave em RASTREADOR_VAULT_KEY, so no backend). Service-role only + RLS.';
COMMENT ON COLUMN public.rastreador_credentials.password_cipher IS
  'pgp_sym_encrypt(senha, :key) -> bytea. NUNCA texto puro; NUNCA selecionar no list (so IS NOT NULL).';
