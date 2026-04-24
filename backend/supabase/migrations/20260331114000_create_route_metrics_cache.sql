CREATE TABLE IF NOT EXISTS public.route_metrics_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  origin_key TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  distancia_km NUMERIC NOT NULL,
  duracao_horas NUMERIC NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT route_metrics_cache_origin_destination_key_unique UNIQUE (origin_key, destination_key)
);

ALTER TABLE public.route_metrics_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view route cache"
ON public.route_metrics_cache
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert route cache"
ON public.route_metrics_cache
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update route cache"
ON public.route_metrics_cache
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);
