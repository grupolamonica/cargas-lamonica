-- =============================================================================
-- Migration: NOT NULL em driver_profiles.phone e document_number (C-05)
-- Auditoria 15/04/2026: campos obrigatórios devem ter restrição NOT NULL
-- para evitar registros inválidos que quebram deduplicação e validações.
-- =============================================================================

-- Backfill de valores NULL antes de aplicar restrição NOT NULL.
-- Registros sem telefone/documento recebem string vazia como placeholder seguro.
UPDATE public.driver_profiles
SET phone = ''
WHERE phone IS NULL;

UPDATE public.driver_profiles
SET document_number = ''
WHERE document_number IS NULL;

-- Aplicar restrições NOT NULL com default '' para novos registros.
ALTER TABLE public.driver_profiles
  ALTER COLUMN phone SET NOT NULL,
  ALTER COLUMN phone SET DEFAULT '',
  ALTER COLUMN document_number SET NOT NULL,
  ALTER COLUMN document_number SET DEFAULT '';
