-- HOTFIX: bucket Supabase Storage `cadastro-drafts` nao existe em prod (lbpzkdec)
-- — upload de CNH/CRLV/comprovantes do wizard de cadastro falha com "Bucket not found".
--
-- Mesmo padrao da migration 20260524000000: bucket foi criado direto via Supabase
-- Studio so em staging (oklksqv), nunca foi versionado no repo. Em staging existe
-- com 303 objetos. Em prod nao existe (zero buckets criados).
--
-- O backend usa getAdminClient() (service role key) para uploads → bypassa RLS,
-- portanto nao precisamos criar policies em storage.objects para esse fluxo.
--
-- Idempotente (ON CONFLICT DO NOTHING). Config espelha staging:
--   - private (public=false)
--   - 8 MiB file_size_limit (espelha DRAFT_FILE_MAX_BYTES no upload-draft-file.js)
--   - allowed_mime_types: JPEG, PNG, HEIC, HEIF, PDF (espelha MIME_TO_EXT)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'cadastro-drafts',
  'cadastro-drafts',
  false,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;
