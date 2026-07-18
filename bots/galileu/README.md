# bots/galileu — Coletor Nestlé (Projeto Galileu adaptado)

Sidecar que extrai as **ofertas/programações da Nestlé** do TMS **Galileo** (via RPC) e
faz upsert em `public.nestle_ofertas` do banco do **Cargas Lamônica**. A tela
**Programação** lê essa tabela como a fonte **Nestlé** (ao lado das viagens SPX/Shopee).

Adaptado de `Projeto-Galileu/nestle/` (`galileu_client.py`, `robo_coleta.py`,
`classificador.py`, `supabase_client.py`). Diferença: o Supabase de **destino** é o do
Lamônica (`NESTLE_SUPABASE_*` → cai p/ `SUPABASE_*`), não o Supabase próprio da Nestlé.

## O que faz
- `run_coleta.py` — loop: a cada `NESTLE_COLETA_INTERVAL_SEC` (default 60s) chama
  `robo_coleta.executar()`.
- `robo_coleta.executar()` — lista todas as programações (`ColetaServicePlus.listarProgramacoes`),
  classifica (`CONTRATO/ADICIONAL/LEILAO`), mapeia e faz `upsert(on_conflict=codprogcoleta)`
  em `nestle_ofertas`. Pula as já em status final.

## Escopo (por enquanto)
- **Só coleta de ofertas** (feed da Programação). **NÃO** faz aceite (o aceite da Nestlé
  segue no Projeto Galileu original / `robo_aceite`). Sem embarques/estadias/ocorrências
  (podem ser adicionados depois, mesmo padrão).

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
