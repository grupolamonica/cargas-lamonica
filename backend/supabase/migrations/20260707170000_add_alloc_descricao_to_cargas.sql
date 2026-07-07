-- Motivo da última troca de motorista/veículo feita pelo operador no Monitor.
-- Preenchido no modal "Confirmar troca de motorista/veículo" (obrigatório no
-- front ao trocar motorista/veículo) e registrado também no audit log.
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS) — retrocompatível, NULL =
-- "sem motivo registrado" (cargas antigas / edições que não trocam m/v).
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_descricao TEXT;
