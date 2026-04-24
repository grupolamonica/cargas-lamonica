CREATE OR REPLACE FUNCTION public.current_operator_access_level()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN public.current_app_role() <> 'operator' THEN NULL
    WHEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '') IS NULL THEN 'advanced'
    WHEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '') IN ('advanced', 'intermediate')
      THEN NULLIF(lower(btrim(auth.jwt() -> 'app_metadata' ->> 'access_level')), '')
    ELSE NULL
  END;
$$;

DROP POLICY IF EXISTS "Operators can insert cargas" ON public.cargas;
DROP POLICY IF EXISTS "Operators can update cargas" ON public.cargas;
DROP POLICY IF EXISTS "Operators can delete cargas" ON public.cargas;

CREATE POLICY "Operators can insert cargas"
ON public.cargas
FOR INSERT
TO authenticated
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));

CREATE POLICY "Operators can update cargas"
ON public.cargas
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'))
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));

CREATE POLICY "Operators can delete cargas"
ON public.cargas
FOR DELETE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'));

DROP POLICY IF EXISTS "Operators can insert clientes" ON public.clientes;
DROP POLICY IF EXISTS "Operators can update clientes" ON public.clientes;
DROP POLICY IF EXISTS "Operators can delete clientes" ON public.clientes;

CREATE POLICY "Operators can insert clientes"
ON public.clientes
FOR INSERT
TO authenticated
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update clientes"
ON public.clientes
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can delete clientes"
ON public.clientes
FOR DELETE
TO authenticated
USING (public.current_operator_access_level() = 'advanced');

DROP POLICY IF EXISTS "Operators can insert route cache" ON public.route_metrics_cache;
DROP POLICY IF EXISTS "Operators can update route cache" ON public.route_metrics_cache;

CREATE POLICY "Operators can insert route cache"
ON public.route_metrics_cache
FOR INSERT
TO authenticated
WITH CHECK (public.current_operator_access_level() = 'advanced');

CREATE POLICY "Operators can update route cache"
ON public.route_metrics_cache
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

DROP POLICY IF EXISTS "Operators can update driver profiles" ON public.driver_profiles;

CREATE POLICY "Operators can update driver profiles"
ON public.driver_profiles
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() = 'advanced')
WITH CHECK (public.current_operator_access_level() = 'advanced');

DROP POLICY IF EXISTS "Operators can update public load leads" ON public.load_public_leads;

CREATE POLICY "Operators can update public load leads"
ON public.load_public_leads
FOR UPDATE
TO authenticated
USING (public.current_operator_access_level() IN ('advanced', 'intermediate'))
WITH CHECK (public.current_operator_access_level() IN ('advanced', 'intermediate'));
