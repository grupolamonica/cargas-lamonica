-- Vínculo do motorista (AGREGADO DEDICADO / PME / FROTA / PX) usado para exibir
-- ao lado do nome do motorista na fila do operador.
--
-- Fonte da verdade: aba "Vinculo" da planilha Google Sheets "Lamonica Shopee"
-- (colunas Motoristas | Vinculo). Populada periodicamente pelo sheet sync do
-- backend (syncDriverVinculos), em paralelo ao sync de cargas. A chave de
-- junção é o NOME normalizado (a aba não tem CPF) — `nome_normalizado` é
-- gerado por normalizeDriverNameKey (lowercase, sem acentos, espaços colapsados)
-- tanto na escrita (sync) quanto na leitura (read model da fila).

-- Idempotente: em prod esta tabela já existe (aplicada ad-hoc sob outro timestamp);
-- re-rodar não pode falhar.
CREATE TABLE IF NOT EXISTS public.driver_vinculos (
  nome_normalizado TEXT PRIMARY KEY,        -- chave de junção (sem acento, lower, trim)
  nome_original    TEXT NOT NULL,           -- nome como veio da planilha (exibição/debug)
  vinculo          TEXT NOT NULL,           -- AGREGADO DEDICADO | PME | FROTA | PX | ...
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.driver_vinculos ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de aspx_drivers: apenas service-role (backend / sync job) lê/escreve.
-- O read model da fila lê via conexão direta do backend (owner — bypassa RLS),
-- exatamente como já faz com aspx_drivers.
DROP POLICY IF EXISTS "service role manages driver_vinculos" ON public.driver_vinculos;
CREATE POLICY "service role manages driver_vinculos"
ON public.driver_vinculos
AS PERMISSIVE
FOR ALL
TO service_role
USING (TRUE)
WITH CHECK (TRUE);
