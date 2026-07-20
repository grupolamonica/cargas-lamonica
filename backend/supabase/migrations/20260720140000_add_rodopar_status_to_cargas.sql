-- Monitor — "Check Rodopar" (DC-260): marca se a carga já foi lançada no Rodopar.
-- Estado por carga, alternado pelo operador na tela /planilha (linha + modal):
--   0 = NÃO lançado        (vermelho)  ← default
--   1 = lançado            (preto)
--   2 = lançado incorreto  (azul)      (lançado mas incorreto/incompleto)
--
-- Aditiva e idempotente (padrão das migrations add_alloc_* / add_sheet_*). smallint
-- NOT NULL DEFAULT 0: em Postgres 11+ default constante é metadata-only (sem rewrite).
-- O SYNC da planilha NUNCA toca este campo (só o operador), então é durável.
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS rodopar_status SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS rodopar_updated_at TIMESTAMPTZ;
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS rodopar_updated_by UUID;
