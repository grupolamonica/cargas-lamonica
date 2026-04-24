ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS driver_visibility TEXT;

UPDATE public.cargas
SET driver_visibility = 'PUBLIC'
WHERE driver_visibility IS NULL OR BTRIM(driver_visibility) = '';

ALTER TABLE public.cargas
ALTER COLUMN driver_visibility SET DEFAULT 'PUBLIC';

ALTER TABLE public.cargas
ALTER COLUMN driver_visibility SET NOT NULL;

ALTER TABLE public.cargas
DROP CONSTRAINT IF EXISTS cargas_driver_visibility_check;

ALTER TABLE public.cargas
ADD CONSTRAINT cargas_driver_visibility_check
CHECK (driver_visibility IN ('PUBLIC', 'PREMIUM'));
