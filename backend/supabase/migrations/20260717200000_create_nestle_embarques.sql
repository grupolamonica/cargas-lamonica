-- Projeto Galileu (Nestlé) — embarques (viagens aceitas) dentro do Cargas Lamônica.
--
-- Espelho de nestle_embarques do Projeto Galileu (robo_embarques →
-- EmbarqueServicePlus.getInfoConfirmacaoEntrega). Traz o estado REAL da viagem aceita:
-- motorista (mot1_nome), placa, status (AGUARDANDO INICIO/EM VIAGEM/FINALIZADO) e as
-- etapas de coleta/entrega (com horários de conclusão). A tela Programação usa isto p/
-- ENRIQUECER as cargas Nestlé aceitas (motorista/placa/status; FINALIZADO → concluído).
-- Populada pelo coletor bots/galileu. Datas do Galileo como TEXT (ISO naive, BRT).

CREATE TABLE IF NOT EXISTS public.nestle_embarques (
  codembarque           text PRIMARY KEY,
  codstatembarque       text,
  descrstatembarque     text,
  dtahrstatembarque     text,
  descrtpoper           text,
  temocorrencia         boolean,
  codmot1               text,
  mot1_nome             text,
  codveic               text,
  veic_id               text,
  placacarreta          text,
  totnumvol             numeric,
  totpeso               numeric,
  totvol                numeric,
  coleta_cidade         text,
  coleta_dtahrprevini   text,
  coleta_dtahrchegada   text,
  coleta_dtahrfim       text,
  entrega_cidade        text,
  entrega_dtahrprevini  text,
  entrega_dtahrchegada  text,
  entrega_dtahrfim      text,
  idcargas              text,
  atualizado_em         timestamptz
);

ALTER TABLE public.nestle_embarques ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view nestle embarques" ON public.nestle_embarques;
CREATE POLICY "Operators can view nestle embarques"
  ON public.nestle_embarques
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
