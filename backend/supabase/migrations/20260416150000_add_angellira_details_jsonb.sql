-- Add angellira_details JSONB column to driver_profiles and vehicles tables.
-- Stores the full detailed response from Angellira API (driver personal data,
-- vehicle specs, etc.) without requiring individual columns for each field.

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS angellira_details jsonb DEFAULT NULL;

COMMENT ON COLUMN public.driver_profiles.angellira_details IS
  'Full Angellira driver details: name, cpf, birthDate, rg, uf, fatherName, motherName, cnhNumber, cnhCategory, cnhSecurityCode, cnhValidity, phone, city';

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS angellira_details jsonb DEFAULT NULL;

COMMENT ON COLUMN public.vehicles.angellira_details IS
  'Full Angellira vehicle details: type, plate, brand, model, fabricationYear, modelYear, color, renavam, chassis, antt, uf, lastLicensing';
