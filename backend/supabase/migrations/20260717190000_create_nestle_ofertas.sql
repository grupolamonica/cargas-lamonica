-- Projeto Galileu (Nestlé) — ofertas/programações do TMS Galileo dentro do Cargas Lamônica.
--
-- Espelho da tabela nestle_ofertas do Projeto Galileu (fonte: robo_coleta →
-- ColetaServicePlus.listarProgramacoes). Aqui é populada pelo sidecar bots/galileu
-- (coletor adaptado), que faz upsert por codprogcoleta. A tela Programação lê esta
-- tabela como uma 2ª fonte (Nestlé) ao lado das viagens SPX (Shopee).
--
-- Convenções: campos de data/hora do Galileo ficam como TEXT (ISO naive, wall-clock
-- BRT — o read model interpreta), espelhando o coletor (_to_timestamp → isoformat).
-- Numéricos/booleanos convertidos pelo coletor. PK = codprogcoleta (on_conflict do upsert).

CREATE TABLE IF NOT EXISTS public.nestle_ofertas (
  codprogcoleta              text        PRIMARY KEY,
  codembarque                text,
  codcarga                   text,
  grupos_id                  text,   -- ID do grupo/viagem Nestlé (ex.: B101462743) = "código de viagem"
  descrstatprogcoleta        text,
  descrtpoper                text,
  -- origem / embarque / destino
  emporig_nomecid            text,
  emporig_uf                 text,
  emporig_nomeciduf          text,
  empembar_nome              text,
  empembar_nomeciduf         text,
  empdest_nome               text,
  empdest_nomecid            text,
  empdest_uf                 text,
  empdest_nomeciduf          text,
  -- veículo / carga
  tpveic_nome                text,
  tpcarga_descr              text,
  senhaagendamento           text,
  numciot                    text,
  -- timestamps do Galileo (ISO naive, BRT) — TEXT p/ preservar o wall-clock
  dtahrincl                  text,
  dtahrprevatual             text,   -- dock coleta (carregamento)
  dtahrpreventrega           text,   -- dock entrega (descarga)
  dtahraceite                text,
  dtahrrecusa                text,
  dtahrcancelado             text,
  dtaremessa                 text,
  dtahragendamento           text,
  dtahrlimiteaceite          text,
  -- numéricos
  totalcarga                 numeric,
  totalnumvol                numeric,
  totalpeso                  numeric,
  totalvol                   numeric,
  totalnumpalete             numeric,
  -- booleanos
  leilao                     boolean,
  broadcast                  boolean,
  pode_aceitar               boolean,
  pode_recusar               boolean,
  pode_cancelar              boolean,
  pode_alterar_data          boolean,
  pode_alterar_data_entrega  boolean,
  -- classificação (classificador.py): CONTRATO | ADICIONAL | LEILAO
  tipo                       text,
  -- operacional
  atualizado_em              timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

-- Consultas do read model: por status (aba) e ordenação por carregamento.
CREATE INDEX IF NOT EXISTS idx_nestle_ofertas_status ON public.nestle_ofertas (descrstatprogcoleta);
CREATE INDEX IF NOT EXISTS idx_nestle_ofertas_prevatual ON public.nestle_ofertas (dtahrprevatual);
CREATE INDEX IF NOT EXISTS idx_nestle_ofertas_grupos ON public.nestle_ofertas (grupos_id);

-- RLS: backend conecta como postgres (bypassa RLS). Policy de leitura p/ operador
-- por consistência com o resto do schema (o frontend não lê esta tabela direto —
-- vai pelo endpoint da Programação).
ALTER TABLE public.nestle_ofertas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Operators can view nestle ofertas" ON public.nestle_ofertas;
CREATE POLICY "Operators can view nestle ofertas"
  ON public.nestle_ofertas
  FOR SELECT
  TO authenticated
  USING (public.current_app_role() = 'operator');
