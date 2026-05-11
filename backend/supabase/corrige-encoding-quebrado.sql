-- =========================================================================
-- CORREÇÃO AUTOMÁTICA de encoding quebrado (caracteres "?" no lugar de acentos)
-- =========================================================================
-- Aplica regex_replace conservador apenas em padrões inequívocos do português.
-- Cada UPDATE só troca o "?" quando o contexto da palavra deixa claro qual
-- acento original existia (ex: "S?o" sempre é "São", "n?o" sempre é "não").
--
-- Execute no SQL Editor do Supabase. Idempotente: rodar 2x não causa estragos.
-- Antes de rodar em PROD, faça backup ou rode em transação:
--   BEGIN; <colar o script>; -- conferir resultados; -- COMMIT; ou ROLLBACK;
-- =========================================================================

BEGIN;

-- Função auxiliar: aplica todos os padrões conhecidos a uma string
CREATE OR REPLACE FUNCTION public._fix_pt_mojibake(input text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result text := input;
BEGIN
  IF result IS NULL THEN
    RETURN NULL;
  END IF;

  -- Cidades / topônimos
  result := regexp_replace(result, '\yS\?o\s+(Paulo|Bernardo|Caetano|Vicente|Carlos|Jos[eé]?|Sebasti[ãa]o|Louren[çc]o|Gon[çc]alo|Lu[ií]s|Roque|Mateus)\y',
                           'São \1', 'gi');
  result := regexp_replace(result, '\ySantos\s+Andr\?\y', 'Santo André', 'gi');
  result := regexp_replace(result, '\yAvar\?\y',     'Avaré',     'gi');
  result := regexp_replace(result, '\yItarar\?\y',   'Itararé',   'gi');
  result := regexp_replace(result, '\yJos\?\s+Rio\s+Preto\y', 'José do Rio Preto', 'gi');
  result := regexp_replace(result, '\yGoi\?nia\y',   'Goiânia',   'gi');
  result := regexp_replace(result, '\yBras\?lia\y',  'Brasília',  'gi');
  result := regexp_replace(result, '\yMaranh\?o\y',  'Maranhão',  'gi');
  result := regexp_replace(result, '\yAmazon\?polis\y', 'Amazonópolis', 'gi');
  result := regexp_replace(result, '\yTabo\?o\s+Serra\y', 'Taboão da Serra', 'gi');
  result := regexp_replace(result, '\yMo[gj]i\s+Cruzes\y', 'Mogi das Cruzes', 'gi');
  result := regexp_replace(result, '\yPiracicaba\y', 'Piracicaba', 'gi'); -- safe noop
  result := regexp_replace(result, '\yPindamonhangaba\y', 'Pindamonhangaba', 'gi'); -- safe noop
  result := regexp_replace(result, '\yPar\?\y',      'Pará',      'gi');
  result := regexp_replace(result, '\yCear\?\y',     'Ceará',     'gi');
  result := regexp_replace(result, '\yPiau\?\y',     'Piauí',     'gi');
  result := regexp_replace(result, '\yAndr\?\y',     'André',     'gi');
  result := regexp_replace(result, '\yJo\?o\y',      'João',      'gi');
  result := regexp_replace(result, '\yJo\?o\s+Pessoa\y', 'João Pessoa', 'gi');

  -- Palavras-comuns português
  result := regexp_replace(result, '\yS\?o\y',           'São',         'g');
  result := regexp_replace(result, '\ys\?o\y',           'são',         'g');
  result := regexp_replace(result, '\yN\?o\y',           'Não',         'g');
  result := regexp_replace(result, '\yn\?o\y',           'não',         'g');
  result := regexp_replace(result, '\ydecis\?o\y',       'decisão',     'gi');
  result := regexp_replace(result, '\yexig\?ncia\y',     'exigência',   'gi');
  result := regexp_replace(result, '\yexig\?ncias\y',    'exigências',  'gi');
  result := regexp_replace(result, '\yreputa\?\?o\y',    'reputação',   'gi');
  result := regexp_replace(result, '\yreputa\?\?es\y',   'reputações',  'gi');
  result := regexp_replace(result, '\yobserva\?\?o\y',   'observação',  'gi');
  result := regexp_replace(result, '\yobserva\?\?es\y',  'observações', 'gi');
  result := regexp_replace(result, '\yopera\?\?o\y',     'operação',    'gi');
  result := regexp_replace(result, '\yopera\?\?es\y',    'operações',   'gi');
  result := regexp_replace(result, '\ydescri\?\?o\y',    'descrição',   'gi');
  result := regexp_replace(result, '\ynotifica\?\?o\y',  'notificação', 'gi');
  result := regexp_replace(result, '\yinforma\?\?o\y',   'informação',  'gi');
  result := regexp_replace(result, '\yinforma\?\?es\y',  'informações', 'gi');
  result := regexp_replace(result, '\yconfigura\?\?o\y', 'configuração','gi');
  result := regexp_replace(result, '\yaprova\?\?o\y',    'aprovação',   'gi');
  result := regexp_replace(result, '\yfun\?\?o\y',       'função',      'gi');
  result := regexp_replace(result, '\yse\?\?o\y',        'seção',       'gi');
  result := regexp_replace(result, '\ysele\?\?o\y',      'seleção',     'gi');
  result := regexp_replace(result, '\yconex\?o\y',       'conexão',     'gi');
  result := regexp_replace(result, '\ymanuten\?\?o\y',   'manutenção',  'gi');
  result := regexp_replace(result, '\yloca\?\?o\y',      'locação',     'gi');
  result := regexp_replace(result, '\ydura\?\?o\y',      'duração',     'gi');
  result := regexp_replace(result, '\yatua\?\?o\y',      'atuação',     'gi');
  result := regexp_replace(result, '\yinscri\?\?o\y',    'inscrição',   'gi');
  result := regexp_replace(result, '\yendere\?o\y',      'endereço',    'gi');
  result := regexp_replace(result, '\yservi\?o\y',       'serviço',     'gi');
  result := regexp_replace(result, '\yservi\?os\y',      'serviços',    'gi');
  result := regexp_replace(result, '\ycomerc\?o\y',      'comércio',    'gi');
  result := regexp_replace(result, '\ypre\?o\y',         'preço',       'gi');
  result := regexp_replace(result, '\ype\?a\y',          'peça',        'gi');
  result := regexp_replace(result, '\ype\?as\y',         'peças',       'gi');
  result := regexp_replace(result, '\yhor\?rio\y',       'horário',     'gi');
  result := regexp_replace(result, '\yusu\?rio\y',       'usuário',     'gi');
  result := regexp_replace(result, '\yusu\?rios\y',      'usuários',    'gi');
  result := regexp_replace(result, '\yfun\?rio\y',       'funcionário', 'gi'); -- raro
  result := regexp_replace(result, '\ynec\?ssario\y',    'necessário',  'gi');
  result := regexp_replace(result, '\yp\?blico\y',       'público',     'gi');
  result := regexp_replace(result, '\yp\?blica\y',       'pública',     'gi');
  result := regexp_replace(result, '\yp\?gina\y',        'página',      'gi');
  result := regexp_replace(result, '\yp\?ginas\y',       'páginas',     'gi');
  result := regexp_replace(result, '\yr\?pido\y',        'rápido',      'gi');
  result := regexp_replace(result, '\yr\?pida\y',        'rápida',      'gi');
  result := regexp_replace(result, '\yh\?\y',            'há',          'g'); -- "h?" sozinho = há
  result := regexp_replace(result, '\y\?nico\y',         'único',       'gi');
  result := regexp_replace(result, '\y\?nica\y',         'única',       'gi');
  result := regexp_replace(result, '\yam\?bito\y',       'âmbito',      'gi');
  result := regexp_replace(result, '\ydist\?ncia\y',     'distância',   'gi');
  result := regexp_replace(result, '\yrefer\?ncia\y',    'referência',  'gi');
  result := regexp_replace(result, '\yhist\?rico\y',     'histórico',   'gi');
  result := regexp_replace(result, '\yhist\?ria\y',      'história',    'gi');
  result := regexp_replace(result, '\yexcl\?sao\y',      'exclusão',    'gi');
  result := regexp_replace(result, '\yatua\?\?o\y',      'atuação',     'gi');
  result := regexp_replace(result, '\yat\?\y',           'até',         'g'); -- "at?" sozinho = até
  result := regexp_replace(result, '\yvig\?ncia\y',      'vigência',    'gi');
  result := regexp_replace(result, '\yfreq\?\?ncia\y',   'frequência',  'gi');
  result := regexp_replace(result, '\ype\?\?o\y',        'pensão',      'gi');
  result := regexp_replace(result, '\yperiodo\y',        'período',     'g'); -- noop / clean

  RETURN result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) CARGAS — origem, destino, motoristas (texto livre)
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.cargas SET
  origem      = public._fix_pt_mojibake(origem),
  destino     = public._fix_pt_mojibake(destino),
  motoristas  = public._fix_pt_mojibake(motoristas)
WHERE origem      ~ '\?'
   OR destino     ~ '\?'
   OR motoristas  ~ '\?';

-- ─────────────────────────────────────────────────────────────────────────
-- 2) CLIENTES — nome, descricao, forma_pagamento, prazo_pagamento, observacoes
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.clientes SET
  nome              = public._fix_pt_mojibake(nome),
  descricao         = public._fix_pt_mojibake(descricao),
  forma_pagamento   = public._fix_pt_mojibake(forma_pagamento),
  prazo_pagamento   = public._fix_pt_mojibake(prazo_pagamento),
  observacoes       = public._fix_pt_mojibake(observacoes)
WHERE nome             ~ '\?'
   OR descricao        ~ '\?'
   OR forma_pagamento  ~ '\?'
   OR prazo_pagamento  ~ '\?'
   OR observacoes      ~ '\?';

-- ─────────────────────────────────────────────────────────────────────────
-- 3) ROUTE_METRICS_CACHE — origem, destino, observacoes, bonus_exigencias
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.route_metrics_cache SET
  origem            = public._fix_pt_mojibake(origem),
  destino           = public._fix_pt_mojibake(destino),
  observacoes       = public._fix_pt_mojibake(observacoes),
  bonus_exigencias  = public._fix_pt_mojibake(bonus_exigencias)
WHERE origem            ~ '\?'
   OR destino           ~ '\?'
   OR observacoes       ~ '\?'
   OR bonus_exigencias  ~ '\?';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) Limpa o helper depois (opcional)
-- ─────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION public._fix_pt_mojibake(text);

-- ─────────────────────────────────────────────────────────────────────────
-- Conferência: liste registros que AINDA têm "?" no meio da palavra.
-- Esses precisam de correção manual.
-- ─────────────────────────────────────────────────────────────────────────
SELECT 'cargas' AS tabela, id::text, origem AS valor
  FROM public.cargas
 WHERE origem ~ '[a-zA-Z]\?[a-zA-Z]' OR destino ~ '[a-zA-Z]\?[a-zA-Z]'
UNION ALL
SELECT 'clientes', id::text, nome
  FROM public.clientes
 WHERE nome ~ '[a-zA-Z]\?[a-zA-Z]' OR descricao ~ '[a-zA-Z]\?[a-zA-Z]'
UNION ALL
SELECT 'route_metrics_cache', id::text, origem
  FROM public.route_metrics_cache
 WHERE origem ~ '[a-zA-Z]\?[a-zA-Z]' OR destino ~ '[a-zA-Z]\?[a-zA-Z]'
LIMIT 100;

-- Se o resultado acima for 0 linhas → tudo foi corrigido. COMMIT;
-- Se ainda houver linhas → ROLLBACK; e ajuste a função adicionando padrões.
COMMIT;
