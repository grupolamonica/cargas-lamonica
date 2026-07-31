# bots/galileu — Coletor Nestlé (Projeto Galileu adaptado)

Sidecar que extrai as **ofertas/programações da Nestlé** do TMS **Galileo** (via RPC) e
faz upsert em `public.nestle_ofertas` do banco do **Cargas Lamônica**. A tela
**Programação** lê essa tabela como a fonte **Nestlé** (ao lado das viagens SPX/Shopee).

Adaptado de `Projeto-Galileu/nestle/` (`galileu_client.py`, `robo_coleta.py`,
`classificador.py`, `supabase_client.py`). Diferença: o Supabase de **destino** é o do
Lamônica (`NESTLE_SUPABASE_*` → cai p/ `SUPABASE_*`), não o Supabase próprio da Nestlé.

## O que faz
- `run_coleta.py` — loop: a cada `NESTLE_COLETA_INTERVAL_SEC` (default 60s) chama
  `robo_coleta.executar()` e depois `robo_embarques.executar()`.
- `robo_coleta.executar()` — lista todas as programações (`ColetaServicePlus.listarProgramacoes`),
  classifica (`CONTRATO/ADICIONAL/LEILAO`), mapeia e faz `upsert(on_conflict=codprogcoleta)`
  em `nestle_ofertas`. Pula as já em status final. Devolve os `codembarque` conhecidos
  para a etapa de embarques.
- `robo_embarques.executar()` — para cada `codembarque` ainda não FINALIZADO busca
  `EmbarqueServicePlus.getInfoConfirmacaoEntrega` e faz `upsert(on_conflict=codembarque)`
  em `nestle_embarques` (motorista/placa/status real da viagem).

## Guarda anti no-op (`nestle/change_guard.py`)
Os dois upserts eram cegos: reescreviam TODA linha a cada ciclo (120s em produção),
gerando nova versão de heap + índices + WAL mesmo para linha byte-idêntica (dead tuples,
bloat, autovacuum, egresso). Agora um espelho em processo (`{chave: digest}`), semeado por
um snapshot paginado e mantido pelas próprias gravações confirmadas, filtra o que não
mudou — ciclo estável ⇒ **zero linhas reescritas**. O espelho também serve o conjunto de
`codembarque` para o passo de embarques, que por isso não varre mais a `nestle_ofertas`
inteira a cada ciclo.

Fail-safe: lote que falha sai do espelho (reenviado no ciclo seguinte); snapshot com erro
não é cacheado; sem espelho, grava tudo (comportamento original). Knobs em `.env.example`
(`NESTLE_UPSERT_GUARD_ENABLED`, `NESTLE_*_SNAPSHOT_TTL_SEC`).

## Escopo (por enquanto)
- **Ofertas + embarques** (feed da Programação e o enriquecimento motorista/placa/status).
  **NÃO** faz aceite (o aceite da Nestlé segue no Projeto Galileu original / `robo_aceite`).
  Sem estadias/ocorrências (podem ser adicionados depois, mesmo padrão).

## Testes
```
cd bots/galileu
python -m pytest tests -q     # cliente Supabase fake, sem rede/banco
```
> Ainda **não** rodam no CI: o job `bots-check` do `.github/workflows/ci.yml` só invoca
> `pytest` em `bots/angelira` e `bots/unificada`. Falta adicionar um step com
> `working-directory: bots/galileu`.

## Variáveis de ambiente
Ver `.env.example`. Obrigatórias: `GALILEU_URL`, `GALILEU_USER`, `GALILEU_PASSWORD`.
Destino: `NESTLE_SUPABASE_URL` + `NESTLE_SUPABASE_SERVICE_ROLE_KEY` (ou `SUPABASE_*`).

> ⚠️ Sem as credenciais do Galileo o coletor não roda. A tabela `nestle_ofertas` e a
> leitura na Programação já funcionam de forma independente (podem ser populadas por
> este coletor OU por seed manual durante testes).

## Rodar local
```
cd bots/galileu
cp .env.example .env   # preencher GALILEU_* e NESTLE_SUPABASE_*
pip install -r requirements.txt
python run_coleta.py
```

## Docker / compose
Serviço `galileu-bot` no `docker-compose.yml` (rede `lamonica-net`, `env_file: backend.env`).
Buildar no deploy: incluir `galileu-bot` na lista de `docker compose ... build` do `deploy.yml`.
