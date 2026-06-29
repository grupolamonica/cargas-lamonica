-- Corrige mojibake legado nos nomes de rota (ã/é/ç/õ → "?") em cargas / reservas /
-- códigos de rota. Origem da corrupção: um sync ANTIGO que decodificava o CSV do
-- Google Sheets como latin1; o sync atual já força UTF-8 (TextDecoder em
-- google-sheet-loads.js) e NÃO reproduz mais o "?". A planilha-fonte (snapshot)
-- está limpa — estas são linhas históricas que nunca foram reescritas.
--
-- O mojibake fazia a MESMA rota aparecer duplicada (filtro de rotas, código de rota,
-- contagem de standby). Mapeamento literal-exato (sem LIKE) → idempotente: rodar de
-- novo é no-op. Mapa derivado do snapshot (autoritativo) + ortografia PT-BR.

BEGIN;

-- cargas.origem
UPDATE public.cargas c SET origem = m.good
FROM (VALUES
  ('Jaboat?o dos Guararapes / PE', 'Jaboatão dos Guararapes / PE'),
  ('S?o Paulo-02 / SP',            'São Paulo-02 / SP'),
  ('Salvador Piraj? / BA',         'Salvador Pirajá / BA'),
  ('S?o Jos? do Rio Preto/SP',     'São José do Rio Preto/SP'),
  ('Cama?ari / BA',                'Camaçari / BA'),
  ('Jaboat?o/PE',                  'Jaboatão/PE'),
  ('Sim?es Filho / BA',            'Simões Filho / BA')
) AS m(bad, good)
WHERE c.origem = m.bad;

-- cargas.destino
UPDATE public.cargas c SET destino = m.good
FROM (VALUES
  ('Jaboat?o dos Guararapes / PE', 'Jaboatão dos Guararapes / PE'),
  ('S?o Paulo-02 / SP',            'São Paulo-02 / SP'),
  ('Salvador Piraj? / BA',         'Salvador Pirajá / BA'),
  ('S?o Jos? do Rio Preto/SP',     'São José do Rio Preto/SP'),
  ('Cama?ari / BA',                'Camaçari / BA'),
  ('Jaboat?o/PE',                  'Jaboatão/PE'),
  ('Sim?es Filho / BA',            'Simões Filho / BA')
) AS m(bad, good)
WHERE c.destino = m.bad;

-- monitor_reservas.origem
UPDATE public.monitor_reservas r SET origem = m.good
FROM (VALUES
  ('Jaboat?o dos Guararapes / PE', 'Jaboatão dos Guararapes / PE'),
  ('S?o Paulo-02 / SP',            'São Paulo-02 / SP'),
  ('Salvador Piraj? / BA',         'Salvador Pirajá / BA'),
  ('S?o Jos? do Rio Preto/SP',     'São José do Rio Preto/SP'),
  ('Cama?ari / BA',                'Camaçari / BA'),
  ('Jaboat?o/PE',                  'Jaboatão/PE'),
  ('Sim?es Filho / BA',            'Simões Filho / BA')
) AS m(bad, good)
WHERE r.origem = m.bad;

-- monitor_reservas.destino
UPDATE public.monitor_reservas r SET destino = m.good
FROM (VALUES
  ('Jaboat?o dos Guararapes / PE', 'Jaboatão dos Guararapes / PE'),
  ('S?o Paulo-02 / SP',            'São Paulo-02 / SP'),
  ('Salvador Piraj? / BA',         'Salvador Pirajá / BA'),
  ('S?o Jos? do Rio Preto/SP',     'São José do Rio Preto/SP'),
  ('Cama?ari / BA',                'Camaçari / BA'),
  ('Jaboat?o/PE',                  'Jaboatão/PE'),
  ('Sim?es Filho / BA',            'Simões Filho / BA')
) AS m(bad, good)
WHERE r.destino = m.bad;

-- Reconstrói o route_key composto (origem→destino) das reservas ainda corrompidas.
UPDATE public.monitor_reservas
SET route_key = origem || '→' || destino
WHERE route_key LIKE '%?%';

-- Códigos de rota: remove os de chave corrompida. São DISPLAY-ONLY (sem FK, sem
-- referência em cargas) e re-derivados na leitura do Monitor — após a limpeza acima
-- a rota limpa reusa o código-gêmeo existente (ou ganha um novo na próxima leitura).
DELETE FROM public.monitor_route_codes
WHERE origin_key LIKE '%?%' OR destination_key LIKE '%?%';

COMMIT;
