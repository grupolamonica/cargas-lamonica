-- DC-283 / CRIT-3 + ALTO-3 — token de posse do rascunho anônimo.
--
-- Hoje o rascunho de candidatura é autorizado pelo CPF: `GET /api/candidatura/
-- draft/me?cpf=` devolve a ficha inteira (CNH, RG, endereço, credencial de
-- rastreador) para qualquer CPF informado, e o POST sobrescreve do mesmo jeito.
-- CPF não é segredo no Brasil — listas são baratas —, então isso é coleta em
-- massa de PII sensível por um atacante anônimo (OWASP API1, BOLA).
--
-- A partir daqui o servidor emite um token opaco na PRIMEIRA gravação do
-- rascunho e passa a exigi-lo na leitura e nas gravações seguintes. Guardamos
-- só o SHA-256: vazamento desta coluna não dá acesso a rascunho nenhum.
--
-- Nullable de propósito: os rascunhos que já existem nascem sem token. A
-- adoção acontece na próxima gravação (ver save-draft-by-cpf.js) e a janela
-- fecha sozinha, porque rascunho expira em 72h.
ALTER TABLE public.pending_driver_registrations
  ADD COLUMN IF NOT EXISTS draft_token_hash TEXT;

COMMENT ON COLUMN public.pending_driver_registrations.draft_token_hash IS
  'SHA-256 (hex) do token de posse do rascunho anônimo. NULL = rascunho legado, adotado na próxima gravação. Nunca guarda o token em claro.';

-- Índice do caminho de leitura: o GET público passa a buscar por hash de token,
-- não mais por CPF. Parcial porque só rascunho anônimo vivo tem token.
CREATE INDEX IF NOT EXISTS idx_pdr_draft_token_hash
  ON public.pending_driver_registrations (draft_token_hash)
  WHERE draft_token_hash IS NOT NULL
    AND status = 'draft'
    AND versao_cadastro = 'v2';
