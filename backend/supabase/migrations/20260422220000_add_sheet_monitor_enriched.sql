-- Stores per-LH Angellira + ASPX enriched data.
-- Updated by POST /api/operator/sheet-monitor/enrich.
-- Enrichment runs in batches after each sheet sync.

CREATE TABLE IF NOT EXISTS public.sheet_monitor_enriched (
  lh                            TEXT PRIMARY KEY,

  -- Driver: ASPX name-to-CPF lookup, then Angellira by CPF
  driver_name                   TEXT,
  aspx_cpf                      TEXT,
  aspx_display_name             TEXT,
  angellira_driver_found        BOOLEAN,
  angellira_driver_status       TEXT,
  angellira_driver_valid_until  DATE,
  angellira_driver_status_text  TEXT,
  angellira_driver_details      JSONB,

  -- Cavalo
  cavalo_plate                  TEXT,
  cavalo_source                 TEXT CHECK (cavalo_source IN ('db','angellira','not_found')),
  cavalo_type                   TEXT,
  cavalo_angellira_found        BOOLEAN,
  cavalo_angellira_status       TEXT,
  cavalo_angellira_valid_until  DATE,
  cavalo_angellira_status_text  TEXT,
  cavalo_angellira_display      TEXT,
  cavalo_details                JSONB,

  -- Carreta
  carreta_plate                 TEXT,
  carreta_source                TEXT CHECK (carreta_source IN ('db','angellira','not_found')),
  carreta_type                  TEXT,
  carreta_angellira_found       BOOLEAN,
  carreta_angellira_status      TEXT,
  carreta_angellira_valid_until DATE,
  carreta_angellira_status_text TEXT,
  carreta_angellira_display     TEXT,
  carreta_details               JSONB,

  enriched_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sheet_monitor_enriched ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators can view sheet monitor enriched"
  ON public.sheet_monitor_enriched;

CREATE POLICY "Operators can view sheet monitor enriched"
  ON public.sheet_monitor_enriched
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
