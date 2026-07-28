-- Programação — cor da LINHA por rota (código de PARTIDA + CHEGADA + tipo de VEÍCULO).
--
-- A tela Programação (viagens SPX/Shopee) traz o código da estação de origem/destino
-- (o "[8808]" que vem no nome da estação pela Torre). O operador quer ver a linha da
-- viagem pintada com a cor que ele definiu para aquela rota+veículo — exatamente como
-- ele já colore hoje na planilha. Esta tabela é a fonte da verdade dessas cores; é
-- COMPARTILHADA (todos os operadores veem/editam as mesmas regras) e editável pela
-- própria tela (adicionar / trocar cor / remover).
--
-- `cor` é um hex (#rrggbb) — o operador escolhe qualquer cor num seletor. O seed abaixo
-- traz o mapa inicial que ele mandou (laranja/azul/amarelo) já convertido p/ hex claros
-- (legíveis com texto escuro, no estilo da planilha).

CREATE TABLE IF NOT EXISTS public.programacao_route_colors (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  partida    text        NOT NULL,   -- código da estação de origem (ex.: '8808')
  chegada    text        NOT NULL,   -- código da estação de destino (ex.: '10963')
  veiculo    text        NOT NULL,   -- tipo normalizado (ex.: 'TRUCK', 'CARRETA', 'CARRETA - EXPRESSA')
  cor        text        NOT NULL,   -- hex '#rrggbb'
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT programacao_route_colors_uniq UNIQUE (partida, chegada, veiculo)
);

-- Seed inicial (mapa enviado pelo operador). Idempotente: ON CONFLICT DO NOTHING —
-- rodar de novo não sobrescreve as cores que o operador já ajustou pela tela.
INSERT INTO public.programacao_route_colors (partida, chegada, veiculo, cor)
SELECT partida, chegada, veiculo,
       CASE nome
         WHEN 'laranja' THEN '#fdba74'
         WHEN 'azul'    THEN '#93c5fd'
         WHEN 'amarelo' THEN '#fde047'
       END AS cor
FROM (VALUES
  ('8808','5050','TRUCK','laranja'),
  ('8808','5050','CARRETA','azul'),
  ('8808','5054','CARRETA','amarelo'),
  ('8808','5054','TRUCK','laranja'),
  ('10963','5054','CARRETA','azul'),
  ('10963','5054','TRUCK','laranja'),
  ('8808','5056','TRUCK','laranja'),
  ('8808','5056','CARRETA','azul'),
  ('8808','5261','TRUCK','laranja'),
  ('8808','5261','CARRETA','azul'),
  ('8808','5457','TRUCK','laranja'),
  ('8808','5457','CARRETA','azul'),
  ('8808','5696','TRUCK','laranja'),
  ('8808','5696','CARRETA','azul'),
  ('8808','5938','TRUCK','laranja'),
  ('8808','5938','CARRETA','azul'),
  ('10963','5970','TRUCK','laranja'),
  ('10963','5970','CARRETA','azul'),
  ('8808','6885','TRUCK','laranja'),
  ('8808','6885','CARRETA','azul'),
  ('8808','7675','TRUCK','laranja'),
  ('8808','7675','CARRETA','azul'),
  ('8808','7915','TRUCK','laranja'),
  ('8808','7915','CARRETA','azul'),
  ('8808','8300','TRUCK','laranja'),
  ('8808','8300','CARRETA','azul'),
  ('8808','8300','CARRETA - EXPRESSA','azul'),
  ('8808','8375','CARRETA','azul'),
  ('8808','8505','TRUCK','laranja'),
  ('8808','8505','CARRETA','azul'),
  ('5261','8808','TRUCK','laranja'),
  ('5261','8808','CARRETA','azul'),
  ('5457','8808','TRUCK','laranja'),
  ('5457','8808','CARRETA','azul'),
  ('5487','8808','CARRETA - EXPRESSA','azul'),
  ('5527','8808','TRUCK','laranja'),
  ('5527','8808','CARRETA','azul'),
  ('5696','8808','TRUCK','laranja'),
  ('5696','8808','CARRETA','azul'),
  ('5938','8808','TRUCK','laranja'),
  ('5938','8808','CARRETA','azul'),
  ('6885','8808','TRUCK','laranja'),
  ('6885','8808','CARRETA','azul'),
  ('7515','8808','TRUCK','laranja'),
  ('7515','8808','CARRETA','azul'),
  ('7675','8808','TRUCK','laranja'),
  ('7675','8808','CARRETA','azul'),
  ('7915','8808','TRUCK','laranja'),
  ('8505','8808','TRUCK','laranja'),
  ('8505','8808','CARRETA','azul'),
  ('8808','8808','TRUCK','laranja'),
  ('8808','8808','CARRETA','azul'),
  ('9622','8808','TRUCK','laranja'),
  ('9622','8808','CARRETA','azul'),
  ('9924','8808','TRUCK','laranja'),
  ('9924','8808','CARRETA','azul'),
  ('10105','8808','TRUCK','laranja'),
  ('10105','8808','CARRETA','azul'),
  ('10106','8808','TRUCK','laranja'),
  ('10106','8808','CARRETA','azul'),
  ('10293','8808','TRUCK','laranja'),
  ('10293','8808','CARRETA','azul'),
  ('10963','8808','TRUCK','laranja'),
  ('10963','8808','CARRETA','azul'),
  ('10963','8808','CARRETA - EXPRESSA','azul'),
  ('11023','8808','TRUCK','laranja'),
  ('11023','8808','CARRETA','azul'),
  ('11228','8808','TRUCK','laranja'),
  ('11228','8808','CARRETA','azul'),
  ('11677','8808','TRUCK','laranja'),
  ('11677','8808','CARRETA','azul'),
  ('11972','8808','TRUCK','laranja'),
  ('11972','8808','CARRETA','azul'),
  ('13183','8808','TRUCK','laranja'),
  ('13183','8808','CARRETA','azul'),
  ('8808','9622','TRUCK','laranja'),
  ('8808','9622','CARRETA','azul'),
  ('10963','10043','TRUCK','laranja'),
  ('10963','10043','CARRETA','azul'),
  ('8808','10095','TRUCK','laranja'),
  ('8808','10095','CARRETA','azul'),
  ('8808','10105','TRUCK','laranja'),
  ('8808','10105','CARRETA','azul'),
  ('8808','10106','TRUCK','laranja'),
  ('8808','10106','CARRETA','azul'),
  ('8808','10293','TRUCK','laranja'),
  ('8808','10293','CARRETA','azul'),
  ('5527','10963','TRUCK','laranja'),
  ('5527','10963','CARRETA','azul'),
  ('5696','10963','CARRETA','azul'),
  ('5696','10963','TRUCK','laranja'),
  ('5970','10963','TRUCK','laranja'),
  ('5970','10963','CARRETA','azul'),
  ('7515','10963','TRUCK','laranja'),
  ('7515','10963','CARRETA','azul'),
  ('8808','10963','TRUCK','laranja'),
  ('8808','10963','CARRETA','amarelo'),
  ('10043','10963','TRUCK','laranja'),
  ('10043','10963','CARRETA','azul'),
  ('10105','10963','TRUCK','laranja'),
  ('10105','10963','CARRETA','azul'),
  ('11023','10963','CARRETA','azul'),
  ('11023','10963','TRUCK','laranja'),
  ('11228','10963','CARRETA','azul'),
  ('11228','10963','TRUCK','laranja'),
  ('11677','10963','TRUCK','laranja'),
  ('11677','10963','CARRETA','azul'),
  ('11972','10963','TRUCK','laranja'),
  ('11972','10963','CARRETA','azul'),
  ('8808','11023','TRUCK','laranja'),
  ('8808','11023','CARRETA','azul'),
  ('8808','11228','TRUCK','laranja'),
  ('8808','11228','CARRETA','azul'),
  ('8808','13183','TRUCK','laranja'),
  ('8808','13183','CARRETA','azul'),
  ('8808','13981','CARRETA','azul')
) AS seed(partida, chegada, veiculo, nome)
ON CONFLICT (partida, chegada, veiculo) DO NOTHING;

-- RLS: leitura pelos operadores (o backend escreve como postgres, bypassa RLS).
ALTER TABLE public.programacao_route_colors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view programacao route colors" ON public.programacao_route_colors;
CREATE POLICY "Operators can view programacao route colors"
  ON public.programacao_route_colors
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
