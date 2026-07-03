-- Cookie/credencial do BRK (Brasil Risk) para o card de gestão no painel do operador.
-- Espelha public.aspx_credentials: singleton (id=1), somente service-role.
--
-- O BR System (br2.brasilrisk.com.br) fica atrás do Cloudflare e não tem login
-- programático — o cookie é obtido UMA vez de um Chrome logado (export do
-- Cookie-Editor) e colado no card. Esta tabela é a fonte de verdade que o robô
-- :5010 (lib/brasilrisk_consulta.js) lê para consultar aptidão — mesma ideia do
-- SPX (aspx_credentials.cookies_json). O `user_agent` é guardado porque o
-- cf_clearance do Cloudflare é amarrado ao UA do navegador.

CREATE TABLE IF NOT EXISTS public.brk_credentials (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  cookies_json       jsonb DEFAULT NULL,        -- { nome: valor } (inclui cf_clearance, cokiename)
  user_agent         text DEFAULT NULL,         -- UA do Chrome (cf_clearance é amarrado ao UA)
  cookies_expires_at timestamptz DEFAULT NULL,
  cookies_updated_at timestamptz DEFAULT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brk_credentials_singleton CHECK (id = 1)
);

ALTER TABLE public.brk_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages brk_credentials"
ON public.brk_credentials
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

-- Linha singleton inicial (cookie preenchido depois via card / POST /api/operator/brk/cookie).
INSERT INTO public.brk_credentials (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.brk_credentials IS 'Cookie do BRK (Brasil Risk) p/ o card do painel + leitura pelo robô :5010. Singleton id=1, service-role only. Espelha aspx_credentials.';
COMMENT ON COLUMN public.brk_credentials.cookies_json IS 'Cookies do br2.brasilrisk.com.br no formato {nome: valor} (inclui cf_clearance e cokiename).';
COMMENT ON COLUMN public.brk_credentials.user_agent IS 'User-Agent do Chrome logado — cf_clearance do Cloudflare é amarrado ao UA.';
COMMENT ON COLUMN public.brk_credentials.cookies_expires_at IS 'Prazo (TTL rolante) do cookie; o keep-alive/refresh estende.';
