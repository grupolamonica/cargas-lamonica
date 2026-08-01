-- Detecção de ROTA retirada do ASPX (complemento do "carga fora do ASPX", 20260731170000).
--
-- Caso real que motivou: a Shopee removeu a rota Simões Filho/BA → Itaitinga/CE inteira do
-- portal. 41 cargas lançadas ficaram sem lastro, mas só 7 foram sinalizadas — as outras 34
-- já tinham passado do horário de carregamento, e o job (de propósito) só avalia carga com
-- carregamento por vir, porque provar ausência de carga já carregada dependeria da aba
-- Concluído (janela + paginação) e gerava falso positivo em massa.
--
-- A assinatura confiável para carga passada é a ROTA: quando o portal não tem NENHUMA viagem
-- do trecho e TODAS as cargas lançadas daquele trecho estão ausentes, é retirada de rota — não
-- índice degradado. Ausência precisa ser SUSTENTADA (duas observações separadas no tempo), daí
-- a tabela de estado: o 1º ciclo só observa, o 2º (após a janela) marca.
--
-- aspx_route_absence: uma linha por rota ausente (apagada quando a rota reaparece).
-- cargas.aspx_missing_reason: distingue 'trip_missing' (viagem individual) de 'route_removed'
--   (rota inteira), para o selo na tela de Cargas e para auditoria.

CREATE TABLE IF NOT EXISTS public.aspx_route_absence (
  route_key       TEXT PRIMARY KEY,
  origem          TEXT,
  destino         TEXT,
  first_absent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_present_at TIMESTAMPTZ,
  loads_count     INTEGER NOT NULL DEFAULT 0,
  notified_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.aspx_route_absence IS
  'Rotas sem nenhuma viagem no portal SPX. first_absent_at = início da observação; a marcação das cargas só ocorre depois da janela de confirmação (ASPX_MISSING_ROUTE_MIN_ABSENT_HOURS).';

ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS aspx_missing_reason TEXT;

-- Retrocompatível: marcas antigas (feature anterior) ficam com reason NULL, tratadas como
-- 'trip_missing' na exibição.
