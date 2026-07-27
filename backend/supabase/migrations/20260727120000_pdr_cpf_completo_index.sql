-- RF001 — indice para hasCompleteLocalCadastro (candidatura/use-cases/pre-check.js).
--
-- O pre-check publico agora consulta, a CADA abertura do wizard, se o CPF ja tem
-- um cadastro COMPLETO no nosso portal (status aprovado/concluido). Sem indice,
-- essa query faz seq scan em `pending_driver_registrations` (tabela que so cresce)
-- avaliando regexp_replace linha a linha.
--
-- A expressao do indice bate EXATAMENTE com o WHERE da query (CPF normalizado:
-- so digitos), com predicado parcial nos status completos — assim o planner usa
-- o indice em vez de escanear a tabela toda.
--
-- Idempotente (IF NOT EXISTS). Em producao, se preferir sem lock de escrita,
-- rode com CREATE INDEX CONCURRENTLY manualmente (fora de transacao).

CREATE INDEX IF NOT EXISTS idx_pdr_cpf_digits_completo
  ON public.pending_driver_registrations (
    (regexp_replace(COALESCE(dados->'motorista'->>'cpf', ''), '\D', '', 'g'))
  )
  WHERE status IN ('aprovado', 'concluido');

COMMENT ON INDEX public.idx_pdr_cpf_digits_completo IS
  'RF001: acelera hasCompleteLocalCadastro (pre-check publico) — CPF normalizado (digitos) dos cadastros aprovado/concluido.';
