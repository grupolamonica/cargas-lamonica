-- Configuração do "chamado automático" de cargas órfãs (route-need):
-- quando uma carga OPEN está sem candidatura e o carregamento se aproxima,
-- o sistema chama motoristas que já fizeram a rota e não estão em viagem.
--
-- Controlado pelo operador na tela de Automação:
--   route_need_enabled   — liga/desliga o disparo automático
--   route_need_days_ahead — janela: só cargas que carregam nos próximos N dias
--   route_need_wave_size  — quantos motoristas por onda (escalonado)

ALTER TABLE public.driver_outreach_settings
  ADD COLUMN IF NOT EXISTS route_need_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS route_need_days_ahead integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS route_need_wave_size integer NOT NULL DEFAULT 5;
