ALTER TABLE public.cargas
ADD COLUMN IF NOT EXISTS sheet_data_carregamento TEXT,
ADD COLUMN IF NOT EXISTS sheet_data_descarga TEXT;
