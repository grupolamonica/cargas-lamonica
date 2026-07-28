-- DC-279 — Notificação de spot. O operador escolhe, na tela de Programação, quais
-- ROTAS cadastradas devem "tocar" (alerta sonoro + notificação) quando surgir uma
-- carga spot disponível nelas. A seleção é COMPARTILHADA (singleton id=1, como o
-- toggle de auto-lançamento do DC-201) e guardada como uma lista de route keys
-- normalizadas ("origin_key|destination_key").
--
-- Idempotente: coluna adicionada só se não existir; default lista vazia = nenhuma
-- rota alerta (feature inerte até o operador selecionar).
ALTER TABLE public.programacao_settings
  ADD COLUMN IF NOT EXISTS spot_alert_route_keys jsonb NOT NULL DEFAULT '[]'::jsonb;
