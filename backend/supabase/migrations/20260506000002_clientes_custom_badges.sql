-- Adds two JSONB columns for operator-defined custom reputation and requirement badges.
-- Each item: { id: string, label: string, icon_name: string, active: boolean }
-- Default '[]' — no migration of existing rows needed.

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS custom_reputacoes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS custom_exigencias JSONB NOT NULL DEFAULT '[]'::jsonb;
