-- Agenda "a confirmar": permite lançar uma carga do sistema SEM data/horário de
-- carregamento definidos. Como cargas.data/horario são NOT NULL, a carga entra com um
-- placeholder (hoje BRT + 00:00) e esta flag marca que a agenda ainda não foi confirmada
-- (o rótulo sheet_data_carregamento fica "A confirmar"). O operador confirma a agenda
-- depois (o launch limpa a flag quando passa a ter data real). Cargas "a confirmar"
-- ficam fora do portal do motorista até a confirmação.

ALTER TABLE public.cargas
  ADD COLUMN IF NOT EXISTS agenda_a_confirmar boolean NOT NULL DEFAULT false;
