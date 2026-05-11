-- =========================================================================
-- DIAGNÓSTICO: por que a rota X não mostra cliente vinculado no painel
-- =========================================================================
-- Executar no SQL Editor do Supabase. Cada query retorna uma fatia diferente
-- do que pode estar errado.
-- =========================================================================

-- 1) Quais rotas em public.rotas têm cliente_id setado?
SELECT
  r.id AS rota_id,
  r.origem,
  r.destino,
  r.cliente_id,
  c.nome AS cliente_nome,
  r.ativa,
  r.updated_at
FROM public.rotas r
LEFT JOIN public.clientes c ON c.id = r.cliente_id
WHERE r.cliente_id IS NOT NULL
ORDER BY r.updated_at DESC
LIMIT 50;

-- 2) Para cada rota em route_metrics_cache, achar correspondência em public.rotas
--    (mesmo critério da listagem do painel — case-insensitive + trim).
SELECT
  rmc.id   AS cache_id,
  rmc.origem,
  rmc.destino,
  r.id     AS rota_id,
  r.cliente_id,
  c.nome   AS cliente_nome,
  CASE
    WHEN r.id IS NULL THEN '❌ Rota não existe em public.rotas'
    WHEN r.cliente_id IS NULL THEN '⚠️  Rota existe mas sem cliente'
    ELSE '✅ Vínculo OK'
  END AS status
FROM public.route_metrics_cache rmc
LEFT JOIN public.rotas r
  ON LOWER(BTRIM(r.origem))  = LOWER(BTRIM(rmc.origem))
 AND LOWER(BTRIM(r.destino)) = LOWER(BTRIM(rmc.destino))
LEFT JOIN public.clientes c ON c.id = r.cliente_id
ORDER BY status DESC, rmc.updated_at DESC
LIMIT 100;

-- 3) Mostrar EXATAMENTE os bytes de origem/destino para identificar
--    diferenças invisíveis (whitespace, accent, capitalization).
SELECT
  'route_metrics_cache' AS tabela,
  origem,
  destino,
  LENGTH(origem)  AS len_origem,
  LENGTH(destino) AS len_destino,
  encode(origem::bytea, 'hex')  AS hex_origem,
  encode(destino::bytea, 'hex') AS hex_destino
FROM public.route_metrics_cache
WHERE origem ILIKE '%são bernardo%' OR destino ILIKE '%são bernardo%'
UNION ALL
SELECT
  'rotas',
  origem,
  destino,
  LENGTH(origem),
  LENGTH(destino),
  encode(origem::bytea, 'hex'),
  encode(destino::bytea, 'hex')
FROM public.rotas
WHERE origem ILIKE '%são bernardo%' OR destino ILIKE '%são bernardo%'
LIMIT 20;

-- 4) Rotas em public.rotas que NÃO têm match em route_metrics_cache
--    (essas não aparecem no painel hoje porque a listagem parte do cache).
SELECT
  r.id,
  r.origem,
  r.destino,
  r.cliente_id,
  c.nome AS cliente_nome
FROM public.rotas r
LEFT JOIN public.clientes c ON c.id = r.cliente_id
LEFT JOIN public.route_metrics_cache rmc
  ON LOWER(BTRIM(rmc.origem))  = LOWER(BTRIM(r.origem))
 AND LOWER(BTRIM(rmc.destino)) = LOWER(BTRIM(r.destino))
WHERE rmc.id IS NULL
ORDER BY r.updated_at DESC
LIMIT 50;

-- =========================================================================
-- INTERPRETAÇÃO:
-- Query 1 vazia → nenhuma rota tem cliente vinculado → atomicamente OK,
--                 não há nada para mostrar no painel.
-- Query 2 com '✅ Vínculo OK' → backend deveria mostrar — se não mostra,
--                                deploy não foi feito (Node não reiniciou).
-- Query 2 com '⚠️ Rota existe mas sem cliente' → o attach não chegou em rotas.
-- Query 2 com '❌ Rota não existe em public.rotas' → rota criada após a
--   migration sem sincronizar — o create-route.js corrigido resolve isso
--   (precisa redeploy).
-- Query 3 mostrando hex diferentes → divergência invisível em strings
--   (BOM, NBSP, acento). O JOIN normalizado (LOWER+BTRIM) já cobre case
--   e whitespace nas pontas, mas não acentos diferentes.
-- =========================================================================
