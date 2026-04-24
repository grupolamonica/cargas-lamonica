-- Enable RLS on tables created without it.
-- Both tables are backend-only (service_role); no authenticated/anon direct access needed.

-- vehicles: populated by Angellira lookup during lead validation.
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages vehicles"
ON public.vehicles
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);

-- motoristas_historico: historical driver import from Angellira/ASPX scripts.
ALTER TABLE public.motoristas_historico ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role manages motoristas_historico"
ON public.motoristas_historico
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);
