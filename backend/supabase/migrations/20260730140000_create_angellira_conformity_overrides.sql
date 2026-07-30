-- Conformidade MANUAL do Angellira, decidida pelo operador no modal da carga do
-- Monitor (Aprovado / Não aprovado), com observação OBRIGATÓRIA nos dois lados.
-- É um SELO VISUAL: sobrepõe a exibição do selo Angellira derivado no Monitor,
-- mas NÃO bloqueia alocação nem o portal do motorista.
--
-- Chaveado por ENTIDADE (não por carga): motorista pelo CPF (só dígitos) e veículo
-- pela placa (normalizada, sem separadores, maiúscula) — assim o verdito acompanha
-- o motorista/veículo em todas as cargas e sobrevive ao re-enriquecimento (o overlay
-- é aplicado em read-time no Monitor, nunca persistido em sheet_monitor_enriched).
-- Limpar o verdito = DELETE da linha (volta ao selo derivado).
CREATE TABLE IF NOT EXISTS public.angellira_conformity_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('DRIVER', 'VEHICLE')),
  subject_key  text NOT NULL,            -- DRIVER: CPF só-dígitos; VEHICLE: placa normalizada
  decision     text NOT NULL CHECK (decision IN ('APPROVED', 'NOT_APPROVED')),
  observacao   text NOT NULL,            -- obrigatória (não-vazia) — enforcement no backend (zod + use-case)
  set_by       uuid,                     -- operador que decidiu
  set_by_name  text,
  set_at       timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_key)
);

COMMENT ON TABLE public.angellira_conformity_overrides IS
  'Verdito manual de conformidade Angellira (Aprovado/Não aprovado) por motorista (CPF) ou veículo (placa), setado no modal do Monitor. Selo visual — não bloqueia operação.';
