ALTER TABLE public.load_public_leads
ADD COLUMN IF NOT EXISTS trailer_plate_2 text NOT NULL DEFAULT '';

UPDATE public.cargas
SET perfil = CASE
  WHEN upper(trim(perfil)) IN ('CARRETA', 'CARRETA - EXPRESSA', 'CARRETA EXPRESSA') THEN 'CARRETA'
  WHEN upper(trim(perfil)) IN ('TRUCK', 'TOCO', '3/4') THEN 'TRUCK'
  WHEN upper(trim(perfil)) IN ('BITREM', 'BITRUCK') THEN 'BITREM'
  ELSE perfil
END
WHERE perfil IS NOT NULL;

UPDATE public.route_metrics_cache
SET perfil_padrao = CASE
  WHEN upper(trim(perfil_padrao)) IN ('CARRETA', 'CARRETA - EXPRESSA', 'CARRETA EXPRESSA') THEN 'CARRETA'
  WHEN upper(trim(perfil_padrao)) IN ('TRUCK', 'TOCO', '3/4') THEN 'TRUCK'
  WHEN upper(trim(perfil_padrao)) IN ('BITREM', 'BITRUCK') THEN 'BITREM'
  ELSE perfil_padrao
END
WHERE perfil_padrao IS NOT NULL;

UPDATE public.driver_profiles
SET vehicle_profile = CASE
  WHEN upper(trim(vehicle_profile)) IN ('CARRETA', 'CARRETA - EXPRESSA', 'CARRETA EXPRESSA') THEN 'CARRETA'
  WHEN upper(trim(vehicle_profile)) IN ('TRUCK', 'TOCO', '3/4') THEN 'TRUCK'
  WHEN upper(trim(vehicle_profile)) IN ('BITREM', 'BITRUCK') THEN 'BITREM'
  ELSE vehicle_profile
END
WHERE vehicle_profile IS NOT NULL;

UPDATE public.load_public_leads
SET vehicle_type = CASE
  WHEN upper(trim(vehicle_type)) IN ('CARRETA', 'CARRETA - EXPRESSA', 'CARRETA EXPRESSA') THEN 'CARRETA'
  WHEN upper(trim(vehicle_type)) IN ('TRUCK', 'TOCO', '3/4') THEN 'TRUCK'
  WHEN upper(trim(vehicle_type)) IN ('BITREM', 'BITRUCK') THEN 'BITREM'
  ELSE vehicle_type
END
WHERE vehicle_type IS NOT NULL;

UPDATE public.clientes
SET tipo_veiculo = CASE
  WHEN upper(trim(tipo_veiculo)) IN ('CARRETA', 'CARRETA - EXPRESSA', 'CARRETA EXPRESSA') THEN 'CARRETA'
  WHEN upper(trim(tipo_veiculo)) IN ('TRUCK', 'TOCO', '3/4') THEN 'TRUCK'
  WHEN upper(trim(tipo_veiculo)) IN ('BITREM', 'BITRUCK') THEN 'BITREM'
  ELSE tipo_veiculo
END
WHERE tipo_veiculo IS NOT NULL;

DROP INDEX IF EXISTS ux_load_public_leads_active_identity;

CREATE UNIQUE INDEX IF NOT EXISTS ux_load_public_leads_active_identity
ON public.load_public_leads (load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2)
WHERE status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED');
