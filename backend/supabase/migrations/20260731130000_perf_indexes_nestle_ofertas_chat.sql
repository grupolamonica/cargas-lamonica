-- Perf (round 3) — índices dos dois scans repetidos da Programação (Nestlé) e do Chat.
--
-- ⚠ ESTE ARQUIVO NÃO SE APLICA SOZINHO NO DEPLOY.
-- `.github/workflows/deploy.yml` não tem step de migration (o deploy só faz
-- `docker compose pull && up -d`). Como nas migrations de índice anteriores
-- (20260721190000, 20260727120000), aplique MANUALMENTE em produção via psql —
-- enquanto isso não acontecer o ganho é ZERO. Depois de aplicar, valide o plano
-- com EXPLAIN (ANALYZE, BUFFERS) nas duas queries citadas abaixo.
--
-- ── 1) nestle_ofertas: chave do DISTINCT ON não indexada ─────────────────────
-- A query da Programação (get-programacao.js → fetchNestleOfertasUncached)
-- dedupa por viagem com DISTINCT ON (COALESCE(grupos_id, codprogcoleta)) e
-- ORDER BY COALESCE(grupos_id, codprogcoleta), dtahrprevatual DESC NULLS LAST.
-- Os três índices existentes (idx_nestle_ofertas_status / _prevatual / _grupos,
-- migration 20260717190000) são de coluna única e NENHUM cobre a EXPRESSÃO
-- COALESCE → seq scan + sort da saída do LEFT JOIN a cada miss do micro-cache.
--
-- A ordenação do índice bate EXATAMENTE com a do ORDER BY: a chave é mista
-- (expressão ASC, data DESC NULLS LAST), então um DESC "puro" (= NULLS FIRST) ou
-- um ASC na 2ª coluna não seriam reversíveis por backward scan e o Sort
-- continuaria. Ambas as colunas são text → a expressão casa sem cast.
--
-- Sem predicado parcial DE PROPÓSITO: o filtro de status morto chega como bind
-- param (`<> ALL($1::text[])`), o planner não consegue provar a implicação e
-- ignoraria um índice parcial. E não existe filtro de recência na query porque
-- oferta com dtahrprevatual NULL é "a confirmar" legítima (DC-301/DC-263) —
-- indexar a ordenação, nunca filtrar as linhas.
--
-- ⚠ MEDIÇÃO (postgres:16 local, dados sintéticos com a mesma forma da prod):
--   * 10k linhas / 3.250 grupos (tamanho de hoje): o planner PREFERE o seq scan
--     + quicksort (271 buffers, ~15 ms) e IGNORA este índice. Forçando com
--     enable_seqscan=off o nó Sort DESAPARECE (prova que a ordenação do índice
--     está certa), mas custa 16.360 buffers e não fica mais rápido — ou seja,
--     nesse tamanho o planner está certo e o ganho é ZERO.
--   * 100k linhas / 34.750 grupos (nº de grupos > LIMIT 3000, então o scan
--     ordenado termina cedo): o planner PASSA a escolher o índice — 25 ms /
--     19.863 buffers contra 114 ms + sort externo de 3,5 MB em disco (4,5×).
--   O ganho depende de o nº de grupos ultrapassar o LIMIT 3000 da query. Hoje a
--   prod devolve ~2.700-2.900 grupos, isto é, está NA BORDA: o índice fica
--   ocioso (planner ignora — sem risco de correção, custo = 464 kB + manutenção
--   nos upserts do coletor Galileu) até a tabela crescer, e aí vira ganho real.
--   Corolário: o "~1s" citado no comentário do use case NÃO é o sort (10k linhas
--   ordenam em ~7 ms) — é round-trip do pooler + transferência das ~2.700 linhas
--   largas. Valide com EXPLAIN (ANALYZE, BUFFERS) na prod antes de esperar ganho.

CREATE INDEX IF NOT EXISTS idx_nestle_ofertas_grupo_key_prevatual
  ON public.nestle_ofertas ((COALESCE(grupos_id, codprogcoleta)), dtahrprevatual DESC NULLS LAST);

COMMENT ON INDEX public.idx_nestle_ofertas_grupo_key_prevatual IS
  'Perf: serve o DISTINCT ON (COALESCE(grupos_id, codprogcoleta)) + ORDER BY dtahrprevatual DESC NULLS LAST da Programação (Nestlé). Índice de EXPRESSÃO: se a query trocar a COALESCE, o índice deixa de ser usado silenciosamente.';

-- Stats da nova expressão. ANALYZE é permitido dentro de transação (diferente de
-- VACUUM), então roda junto com a migration; sem isso o planner espera o
-- autovacuum para estimar a chave nova.
ANALYZE public.nestle_ofertas;

-- ── 2) whatsapp_messages: agregado de não lidas sem índice ───────────────────
-- A lista de conversas do Chat (driver-outreach/admin.js →
-- listWhatsappConversations) faz DOIS passes na tabela: o DISTINCT ON (phone),
-- que já tem índice (idx_whatsapp_messages_phone_ts, migration 20260708120000 —
-- por isso NÃO recriamos (phone, timestamp DESC) aqui), e o agregado de não
-- lidas (direction = 'in' AND status <> 'read' GROUP BY phone), esse sem índice
-- nenhum → varre a tabela inteira a cada poll de 20s, por operador.
--
-- O predicado parcial abaixo é IDÊNTICO (literais, não bind params) ao WHERE da
-- CTE, então o planner prova a implicação e troca o scan por um index-only scan
-- sobre só as linhas não lidas (dezenas), já na ordem do GROUP BY.
-- Custo de escrita: a tabela é append-heavy (webhook Evolution) e o índice é
-- minúsculo; marcar como 'read' remove a entrada (churn normal de HOT update).
--
-- MEDIÇÃO (mesmo repro local, 60k mensagens / 800 telefones / 150 não lidas):
-- a perna do agregado saiu de Seq Scan com 1.173 buffers e 59.850 linhas
-- descartadas pelo filtro (~5,2 ms) para Index Only Scan com 2 buffers e
-- Heap Fetches: 0 (~0,02 ms) — 586× menos buffers nessa perna, e o HashAggregate
-- virou GroupAggregate (já ordenado). Query inteira: 23,6 ms → 18,4 ms (-22%),
-- 61.602 → 60.431 buffers. O resto é o DISTINCT ON (phone), que já usa
-- idx_whatsapp_messages_phone_ts e visita a tabela toda por falta de skip scan —
-- reduzir isso é outra mudança (cache/single-flight no use case), não índice.

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_unread_phone
  ON public.whatsapp_messages (phone)
  WHERE direction = 'in' AND status <> 'read';

COMMENT ON INDEX public.idx_whatsapp_messages_unread_phone IS
  'Perf: agregado de não lidas da lista de conversas do Chat (direction = in AND status <> read GROUP BY phone). O predicado precisa continuar idêntico ao WHERE da CTE, senão o planner ignora o índice.';

-- Aditiva e idempotente (IF NOT EXISTS). Tabelas pequenas (nestle_ofertas ~10k
-- linhas) → CREATE INDEX simples, lock ACCESS EXCLUSIVE de milissegundos,
-- aceitável. Em produção, se preferir sem lock de escrita, rode as duas
-- statements como CREATE INDEX CONCURRENTLY manualmente (fora de transação) —
-- mesma nota de 20260528135107_perf_hardening_indexes.sql e 20260727120000.
