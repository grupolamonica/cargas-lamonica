-- Marcador de OBSERVAÇÃO do aceite: a ÚLTIMA vez que olhamos o SPX ao vivo e a
-- resposta foi CONCLUSIVA para aquele LH. Não é "a primeira checagem" — o job regrava
-- a marca conforme re-observa (e só quando a atual já passou de 60 min, para não abrir
-- tempestade de UPDATE/realtime).
--
-- A migration 20260805170000 criou `trip_accepted_at` e o Monitor passou a ler NULL
-- como "ninguém aceitou". Isso confundiu duas coisas MUITO diferentes: "observamos
-- que não está aceita" e "nunca olhamos". Medido em produção hoje (06/08/2026): das
-- 92 cargas lançadas vivas, 82 têm `trip_accepted_at` NULL e 79 delas foram criadas
-- ANTES da coluna existir — nunca tiveram chance de ser marcadas. O read model leu
-- esse silêncio como não-aceite e escondeu 39-50 linhas da fonte SISTEMA, 26 delas
-- ABERTAS no portal /motorista: o motorista podia aceitar uma carga que o operador
-- não enxergava mais.
--
-- Pior, o marcador é estruturalmente perdedor sozinho: o aceite feito DIRETO no
-- portal SPX nunca passa pelo nosso código, então nada o grava (até hoje: 0 cargas
-- "LT…" marcadas, 0 eventos de aceite desde 05/08). Um sinal que só é escrito em um
-- caminho raro não pode ser a base de uma decisão de ESCONDER linha.
--
-- Correção de desenho: aceite vira FATO OBSERVADO, com duas colunas.
--   * `trip_accepted_at`           = observamos que a viagem ESTÁ aceita. Nunca é limpo.
--   * `trip_acceptance_checked_at` = ÚLTIMA observação CONCLUSIVA daquele LH no SPX ao
--                                    vivo (a viagem estava no índice). Regravada a cada
--                                    re-observação, não congelada na primeira.
-- O Monitor só esconde com EVIDÊNCIA de não-aceite:
--   trip_acceptance_checked_at IS NOT NULL AND trip_accepted_at IS NULL.
-- Nunca checado = desconhecido = a linha FICA VISÍVEL. Isso dispensa qualquer corte
-- por data (as lançadas antigas nunca foram checadas, então voltam sozinhas) e faz o
-- sinal se auto-curar: o job re-observa e o estado converge sem intervenção.
--
-- E a evidência TEM PRAZO. Na leitura, `checked_at` mais velho que
-- MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS (default 24h) volta a valer como DESCONHECIDO
-- e a linha reaparece. Isso cobre a carga que sai do recorte do job depois de uma única
-- observação: LT com carregamento às 10:00, observada "não aceita" às 09:50, aceita
-- direto no portal SPX às 10:30 — sem prazo ela ficaria aceita, viva e invisível para
-- o operador justamente no dia do carregamento. O TTL (24h) é folgadamente maior que o
-- intervalo de regravação (60 min), então evidência de carga ativamente observada nunca
-- expira. Regra da casa, que vale para todo este read model: DADO AUSENTE, DUVIDOSO OU
-- VELHO NUNCA ESCONDE LINHA.
--
-- Registro para quem ler depois: o backfill da 20260805170000 gravou 270 marcas
-- FABRICADAS — copiou `updated_at` usando o proxy inválido "o LH desta lançada existe
-- como `sheet_lh` de outra carga", que não prova aceite nenhum. NÃO as limpamos aqui:
-- todas as 270 estão hoje em EXPIRED/RESERVED, portanto já invisíveis no Monitor, e
-- um UPDATE de limpeza dentro de uma migration aditiva é risco sem ganho. A limpeza
-- fica para um script opcional, rodado com os olhos no resultado.
--
-- Aditiva: sem DEFAULT, sem NOT NULL, sem índice, sem backfill.

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS trip_acceptance_checked_at timestamptz;

COMMENT ON COLUMN public.cargas.trip_acceptance_checked_at IS
  'ÚLTIMA observação CONCLUSIVA do aceite desta carga lançada no SPX ao vivo (a viagem estava no índice) — não é a primeira checagem: o job regrava a marca a cada re-observação (só quando a atual já passou de ~60 min, para não gerar UPDATE/realtime à toa). NULL = nunca checado = aceite DESCONHECIDO — NÃO significa "não aceita". O Monitor só esconde a lançada quando há evidência RECENTE: checked_at preenchido, mais novo que MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS (default 24h), E trip_accepted_at nulo. Evidência mais velha que o TTL é tratada como desconhecida na leitura e a linha reaparece.';
