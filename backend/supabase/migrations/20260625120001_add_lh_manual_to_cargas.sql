-- Monitor unificado — LH manual para cargas do SISTEMA (não-Shopee).
--
-- O Monitor passa a mostrar, além das linhas da planilha (sheet_lh != null),
-- as cargas criadas no próprio sistema (sheet_lh IS NULL). Essas cargas não têm
-- um "LH" da planilha; lh_manual guarda um identificador livre que o operador
-- digita no grid (como numa planilha).
--
-- IMPORTANTE: NÃO reaproveitar sheet_lh para isso — o SYNC da planilha trata
-- qualquer carga com sheet_lh preenchido como linha da planilha e expiraria a
-- carga se o LH não estiver no CSV. lh_manual é um campo à parte, ignorado pelo
-- sync, exclusivo de cargas do sistema.
--
-- Aditiva e idempotente. Coluna nullable → sem rewrite da tabela.

ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS lh_manual TEXT;
