CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    lower(
      btrim(
        COALESCE(
          auth.jwt() -> 'app_metadata' ->> 'role',
          auth.jwt() -> 'user_metadata' ->> 'role',
          ''
        )
      )
    ),
    ''
  );
$$;
