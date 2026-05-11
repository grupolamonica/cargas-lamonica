-- Diagnóstico: identifica registros com caracteres "?" suspeitos (perda de UTF-8)
-- Execute no SQL Editor do Supabase para ver QUAIS linhas estão quebradas.
--
-- O padrão `[a-zA-Z]\?[a-zA-Z]` pega "?" no meio de palavras (S?o, exig?ncia,
-- decis?o etc.) — um "?" sozinho ou em fim de frase é normal.

-- 1) Cargas com origem/destino quebrado
SELECT id, origem, destino, data, motoristas, status
FROM public.cargas
WHERE origem  ~ '[a-zA-Z]\?[a-zA-Z]'
   OR destino ~ '[a-zA-Z]\?[a-zA-Z]'
ORDER BY data DESC
LIMIT 100;

-- 2) Clientes com nome/descrição/forma de pagamento quebrado
SELECT id, nome, descricao, forma_pagamento, prazo_pagamento, observacoes
FROM public.clientes
WHERE nome           ~ '[a-zA-Z]\?[a-zA-Z]'
   OR descricao      ~ '[a-zA-Z]\?[a-zA-Z]'
   OR forma_pagamento~ '[a-zA-Z]\?[a-zA-Z]'
   OR prazo_pagamento~ '[a-zA-Z]\?[a-zA-Z]'
   OR observacoes    ~ '[a-zA-Z]\?[a-zA-Z]'
LIMIT 100;

-- 3) Rotas (route_metrics_cache) com observações quebradas
SELECT id, origem, destino, observacoes, bonus_exigencias
FROM public.route_metrics_cache
WHERE origem           ~ '[a-zA-Z]\?[a-zA-Z]'
   OR destino          ~ '[a-zA-Z]\?[a-zA-Z]'
   OR observacoes      ~ '[a-zA-Z]\?[a-zA-Z]'
   OR bonus_exigencias ~ '[a-zA-Z]\?[a-zA-Z]'
LIMIT 100;

-- 4) Detecta também o caractere de substituição U+FFFD (�) — quando o byte
--    foi convertido durante leitura, em vez de ser perdido na escrita.
SELECT 'cargas' AS tabela, id, origem AS valor FROM public.cargas
 WHERE origem LIKE '%' || U&'\fffd' || '%' OR destino LIKE '%' || U&'\fffd' || '%'
UNION ALL
SELECT 'clientes', id, nome FROM public.clientes
 WHERE nome LIKE '%' || U&'\fffd' || '%' OR descricao LIKE '%' || U&'\fffd' || '%'
LIMIT 100;

-- ---------------------------------------------------------------------------
-- CORREÇÃO MANUAL (caso queira fazer UPDATE direto após identificar):
-- UPDATE public.cargas SET destino = 'São Bernardo do Campo, SP' WHERE id = '<UUID>';
--
-- Ou re-sincronize a planilha: a Sheet do Shopee é a fonte de verdade.
--   POST /api/operator/sheet-sync   (com Authorization de operador)
-- ---------------------------------------------------------------------------
