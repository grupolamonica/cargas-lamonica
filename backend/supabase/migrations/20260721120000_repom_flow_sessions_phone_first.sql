-- Repom — a sessão de conversa nasce ANTES de sabermos o CPF (o motorista chama
-- e o bot pergunta o CPF). Torna cpf opcional e garante 1 sessão ativa por
-- TELEFONE (a chave do início da conversa). A unicidade ativa por CPF continua
-- valendo quando o CPF é preenchido (NULLs não participam de índice único).
-- ADITIVA/idempotente; módulo segue OFF.

ALTER TABLE public.repom_flow_sessions ALTER COLUMN cpf DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_repom_flow_sessions_active_phone
  ON public.repom_flow_sessions (phone) WHERE status = 'active';
