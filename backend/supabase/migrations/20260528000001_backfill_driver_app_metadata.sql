-- Security audit (chore/staff-audit, 2026-05-28): backfill app_metadata.role
-- for drivers historically created with only user_metadata.role.
--
-- Pré-requisito para a migração 20260528000002 que remove o fallback
-- inseguro em current_app_role() (user_metadata é writable pelo próprio
-- usuário via supabase.auth.updateUser → vetor de privilege-escalation).
--
-- Escopo INTENCIONALMENTE restrito a role='driver':
--   - Operadores já são criados com app_metadata.role no provision script.
--   - Promover automaticamente quem tem user_metadata.role='operator' poderia
--     elevar um atacante que já explorou o bug.
-- Apenas drivers são backfillados; demais roles devem ser revisados manualmente.

UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('role', 'driver')
WHERE (raw_app_meta_data->>'role') IS NULL
  AND raw_user_meta_data->>'role' = 'driver';
