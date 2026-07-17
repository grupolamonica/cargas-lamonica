-- Coluna metadata em pending_driver_outreach para guardar contexto por envio
-- (ex.: envio em massa registra { audience, rota, origem, destino } — usado
-- pelo follow-up automático quando o motorista aceita a mensagem em massa).
ALTER TABLE public.pending_driver_outreach
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
