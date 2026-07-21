-- Repom Fase 3b — idempotência do processamento de mensagens do webhook.
-- A mesma mensagem do Evolution pode chegar 2x (reentrega / duas instâncias);
-- sem trava, a mídia seria baixada/estagiada e o motorista respondido em
-- duplicidade (lição do sistema local: dedupe em TABELA, não em memória).
-- `file_sha256` permite, no PR de OCR, pular re-processar o MESMO arquivo.
-- ADITIVA/idempotente; nada existente é tocado. Módulo segue OFF.

CREATE TABLE IF NOT EXISTS public.repom_processed_messages (
  external_id text PRIMARY KEY,
  phone       text,
  kind        text NOT NULL DEFAULT 'media',
  file_sha256 text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_repom_processed_phone
  ON public.repom_processed_messages (phone);
