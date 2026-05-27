-- Iter #7 — Multi-draft scoping + duplicate detection on pending_driver_registrations.
--
-- carga_id (TEXT, nullable) e driver_user_id (UUID, nullable) ja existem (criadas
-- por migrations historicas). Esta migration adiciona:
--   1. Indice composto para o save-draft "1 ativo por (driver, carga)" — substitui
--      o lookup atual "1 ativo por driver" (multi-draft simultaneo).
--   2. Indice para list-incomplete-drafts (driver + status='draft' com carga_id NOT NULL).
--   3. Indice expression para duplicate detection por CPF (JSONB) + placa (JSONB).
--
-- Backward-compat: drafts legacy (carga_id IS NULL) sao tratados pelo save-draft
-- via fallback OR no WHERE.
--
-- Idempotente: todos os CREATE INDEX usam IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_pdr_driver_carga_draft
  ON public.pending_driver_registrations (driver_user_id, carga_id, status)
  WHERE status = 'draft' AND versao_cadastro = 'v2';

CREATE INDEX IF NOT EXISTS idx_pdr_driver_drafts_with_carga
  ON public.pending_driver_registrations (driver_user_id, updated_at DESC)
  WHERE status = 'draft' AND versao_cadastro = 'v2' AND carga_id IS NOT NULL;

-- Duplicate detection: pendente/em_analise + (cpf, horse_plate). Os campos sao
-- lidos do JSONB `dados`. Index expression acelera o lookup em pre-check.
-- Sintaxe: precisa de parenteses extras nas expressoes JSONB.
CREATE INDEX IF NOT EXISTS idx_pdr_duplicate_cpf_placa
  ON public.pending_driver_registrations (
    ((dados->'motorista'->>'cpf')),
    ((dados->'cavalo'->>'placa')),
    status,
    created_at DESC
  )
  WHERE status IN ('pendente', 'em_revisao', 'em_analise');

COMMENT ON INDEX public.idx_pdr_driver_carga_draft IS
  'Iter #7: scope draft por (driver_user_id, carga_id) — suporta multi-draft simultaneo.';

COMMENT ON INDEX public.idx_pdr_driver_drafts_with_carga IS
  'Iter #7: list-incomplete-drafts (driver com varios drafts, ordenado por updated_at).';

COMMENT ON INDEX public.idx_pdr_duplicate_cpf_placa IS
  'Iter #7: duplicate detection no pre-check por CPF (motorista) + placa cavalo.';
