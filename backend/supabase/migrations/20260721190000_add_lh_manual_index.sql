-- Índice parcial em cargas.lh_manual (cargas do SISTEMA lançadas na Programação).
--
-- Passou a ser consultado no caminho quente do Monitor:
--   1) updateMonitorAllocation / setMonitorAllocationPin resolvem a carga por
--      `id = createSheetLoadId(lh) OR (lh_manual = lh AND sheet_lh IS NULL)` —
--      uma viagem lançada na Programação vive como carga do sistema (lh_manual)
--      e é editada por LH; sem o fallback a edição da placa/motorista falhava.
--   2) o overlay allocByLh do Monitor lê as cargas do sistema editadas
--      (sheet_lh IS NULL AND lh_manual IS NOT NULL AND alloc_updated_at IS NOT NULL).
--
-- Sem índice essas consultas viram seq scan em public.cargas (milhares de linhas).
-- Índice PARCIAL (só linhas com lh_manual) mantém o índice pequeno.
--
-- Aditiva e idempotente. Tabela pequena → CREATE INDEX simples (lock breve
-- aceitável); IF NOT EXISTS torna o re-run seguro.

CREATE INDEX IF NOT EXISTS idx_cargas_lh_manual
  ON public.cargas (lh_manual)
  WHERE lh_manual IS NOT NULL;
