-- Active loads should be visible to drivers even when they are also templates.
DROP POLICY IF EXISTS "Anyone can view active cargas" ON public.cargas;

CREATE POLICY "Anyone can view active cargas"
ON public.cargas
FOR SELECT
TO anon
USING (status = 'ativa');

-- Drivers no longer need client-level public access because the public screen
-- only consumes the essential fields from cargas.
DROP POLICY IF EXISTS "Anyone can view clientes of active cargas" ON public.clientes;
