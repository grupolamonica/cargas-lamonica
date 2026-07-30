-- Observação de checklist (tratativas) escrita pelo operador no modal da carga do
-- Monitor. Campo livre para registrar a tratativa de uma pendência/inconformidade
-- do checklist do veículo (ex.: "aguardando 2ª via do CRLV", "liberado pela torre").
-- Segue o mesmo padrão de override do operador (alloc_*): o sync da planilha NUNCA
-- toca alloc_*, então a nota sobrevive a cada sincronização. Serve tanto para linhas
-- da planilha (gravada por LH em update-monitor-allocation) quanto para cargas do
-- sistema (por cargoId em update-monitor-cargo).
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS) — retrocompatível, NULL = "sem
-- observação registrada".
ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS alloc_tratativas TEXT;
