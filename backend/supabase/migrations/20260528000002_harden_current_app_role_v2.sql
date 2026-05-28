-- Security audit (chore/staff-audit, 2026-05-28): remove user_metadata fallback
-- from current_app_role().
--
-- Vetor original: user_metadata é writable pelo próprio usuário via
--   supabase.auth.updateUser({ data: { role: "operator" } })
-- Um driver autenticado conseguia chamar a API de PostgREST direto e ser
-- tratado como operator pelas policies RLS (que confiam em current_app_role()).
--
-- Pré-requisito: migração 20260528000001 backfilla drivers existentes para
-- garantir que requireDriverSession (que lê só app_metadata.role) continue
-- aceitando-os.
--
-- A partir desta migração, current_app_role() lê EXCLUSIVAMENTE
-- auth.jwt()->'app_metadata'->>'role' — campo controlado apenas pelo
-- service_role (server-side), nunca pelo próprio usuário.

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    lower(
      btrim(
        COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '')
      )
    ),
    ''
  );
$$;
