-- Override editável do TIPO da carga (ForeCast / Spot / Tendência / SISTEMA) no
-- Monitor do operador. Efetivo = COALESCE(alloc_tipo, sheet_tipo) para linhas da
-- planilha, ou alloc_tipo ?? 'SISTEMA' para cargas do sistema.
--
-- Lido/escrito por update-monitor-allocation, update-monitor-cargo,
-- list-system-cargas-monitor e no overlay allocByLh do handler do Monitor.
-- Estava só no staging (aplicada ad-hoc via MCP) — sem migration no repo.
-- Aditiva/nullable → retrocompatível. Idempotente.
ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS alloc_tipo TEXT;
