# brasilrisk-robo

Cliente Python do **BRSystem2 / Brasil Risk** (`br2.brasilrisk.com.br`) — o sistema
de gerenciamento de risco ("BRK"/Pamcary) onde se cadastra o motorista.

Mesma família do `spx-robo` e `angelira-robo`. Mapa completo da API em
[`../mapeador-api/brasilrisk.api-map.md`](../mapeador-api/brasilrisk.api-map.md).

## Status

⚠️ **Esqueleto baseado no mapa ao vivo (2026-06-26).** O grosso está confirmado
(endpoints, 57 campos do cadastro, tabelas de domínio, modelo de auth). Os pontos
marcados `# CONFIRMAR` no código (nomes de alguns params e o campo do upload)
precisam de **1 HAR** de um cadastro real pra fechar:

```
# grave um HAR de um cadastro completo e rode:
python ../mapeador-api/mapear_api.py brasilrisk.har --nome brasilrisk --scaffold
```

## Arquitetura (resumo)

- ASP.NET MVC clássico → **auth por cookie de sessão** + token anti-CSRF
  `__RequestVerificationToken` (raspado do HTML e reenviado em cada POST).
- ⚠️ **O site fica atrás do Cloudflare.** Login por senha via `requests` toma
  **403** (bot block). Por isso o caminho recomendado é **reusar a sessão do
  navegador** (que já passou pelo Cloudflare e já está logado), como o `spx-robo`:
  ```python
  c = BRSystemClient()
  c.usar_sessao_navegador(cookie_header, user_agent=ua)  # copiados do DevTools
  ```
  Pegue o header **Cookie** e o **User-Agent** em DevTools → Network → qualquer
  request do `br2` → Request Headers. O `cf_clearance` precisa do **mesmo UA**.
  Exemplo pronto: `examples/obter_cadastro_cookie.py` (lê `backend/cookie.txt`).
- O `BRSystemClient.login()` (por senha) existe mas só funciona se o Cloudflare
  não estiver bloqueando — mantido como fallback.
- Upload de foto/CNH é separado (`POST /Motorista/UploadFile`); o caminho
  retornado vai em `CaminhoFoto`/`CaminhoFotoCNH`/`CaminhoPdfCNH` no cadastro.

## Uso

```bash
pip install -r requirements.txt
cd backend
# Windows PowerShell:
$env:BRSYSTEM_USER="seu_login"; $env:BRSYSTEM_PASS="sua_senha"
python -m examples.cadastrar_motorista
```

```python
from brasilrisk_robo.client import BRSystemClient
from brasilrisk_robo import constants as K, motorista as M

c = BRSystemClient()
c.login("usuario", "senha")

# leitura (seguro)
M.buscar_cep(c, "01310-100")
M.buscar_cidade(c, K.UF["SP"])
M.existe_cpf(c, "12345678901")

# >>> TRAZER O CADASTRO DE UM MOTORISTA EXISTENTE — 100% via HTTP, sem navegador:
cad = M.obter_cadastro_por_cpf(c, "76276937487")
print(cad)   # dict name->value (o "JSON" do cadastro)

# cadastro novo (CRIA REGISTRO REAL — confirme contratos antes)
# M.cadastrar_completo(c, dados={...}, foto="f.jpg", pdf_cnh="cnh.pdf")
```

### Ler um cadastro existente via HTTP (`obter_cadastro_por_cpf`)

Faz tudo por HTTP, sem DOM de navegador:
1. `GET /Motorista/ListaMotoristas?cpf=…` → acha o motorista e os IDs (DataTables JSON).
2. `GET /Motorista/Editar?codMotoristaPessoa=…&codEmpresaSolicitante=…&codPesquisaMotorista=…` → HTML do form preenchido.
3. Parse do HTML (stdlib, sem dependência) → dict com os campos.

Pronto pra rodar:
```bash
cd backend
$env:BRSYSTEM_USER="login"; $env:BRSYSTEM_PASS="senha"; $env:CPF="76276937487"
python -m examples.obter_cadastro
```
> `# CONFIRMAR`: as chaves exatas do JSON do grid (`CodMotoristaPessoa`, `CodEmpresaSolicitante`,
> `CodPesquisaMotorista`) são buscadas de forma defensiva. Se não encontrar, o exemplo
> imprime a 1ª linha crua do grid pra mapear as chaves de uma vez.

## ⚠️ Cuidado

`criar()` / `cadastrar_completo()` **gravam motorista de verdade** num sistema de
risco. Não use pra "testar" contra produção — confirme o fluxo com HAR primeiro e
teste com um cadastro real planejado.

## Layout

```
backend/brasilrisk_robo/
  client.py      # sessão, login+CSRF, get/post helpers
  motorista.py   # fluxo: lookups, validações, endereço, upload, criar, LGPD
  constants.py   # BASE_URL + tabelas de domínio (UF, função, perfil, empresa) + 57 campos
  logger.py
backend/examples/cadastrar_motorista.py
```

## Variáveis de ambiente

- `BRSYSTEM_BASE_URL` (default `https://br2.brasilrisk.com.br`)
- `BRSYSTEM_USER`, `BRSYSTEM_PASS` (usados pelo exemplo)

---

## Servidor REST (Node) — consulta de aptidão via API ⭐ (consumo pela VPS)

O `server.js` expõe a consulta READ-ONLY de aptidão como HTTP, para o backend do
cargas-lamonica consumir. O pipeline do badge BRK (PR #67) **já fala esse contrato**
via `backend/src/infrastructure/brk/brk-client.js`. Contrato completo em
[`API_REST.md`](./API_REST.md).

```
GET /api/brk/consultar?cpf=<11díg>&placa=<cavalo>&placa=<carreta>
    Header: X-API-Key: <BRK_API_KEY>
    -> { ok, conjunto_apto, status, color, label, componentes, consultado_em }
GET /health  -> { ok, session }   (sem auth; usado pelo healthcheck do container)
```

Rodar local:
```bash
npm ci
export BRK_API_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm start      # sobe em :8767 (BRK_SIDECAR_PORT)
```

**Env do servidor:** `BRK_API_KEY` (obrigatória), `BRK_SIDECAR_PORT` (8767),
`BRK_SIDECAR_HOST` (0.0.0.0), `BRK_BASE_URL`, `BRK_TIMEOUT_MS` (20000),
`BRK_CACHE_TTL_MS` (300000). A sessão vem de `BRSYSTEM_COOKIE`/`BRSYSTEM_UA` ou de
`backend/cookie.txt` + `backend/useragent.txt`.

### Sessão (cf_clearance) — o ponto crítico do Cloudflare

O BRK fica atrás do **Cloudflare (managed challenge)**: qualquer cliente
não-navegador (curl/Node/requests) toma **403 "Just a moment"**. O replay HTTP da
consulta só passa **enquanto houver um `cf_clearance` válido**, que:

- **nasce de um login HEADED** (um humano resolve o Turnstile 1×):
  `node refresh_cookies_brk_pw.js login` → grava `backend/cookie.txt` + `useragent.txt`;
- tem **TTL ~dias** e é **amarrado ao User-Agent** do navegador que o gerou;
- **NÃO é renovado** pelo keepalive (que só mantém a sessão ASP.NET viva, ~20 min):
  `node keepalive_brk.js` a cada ~10 min (cron/tarefa/loop).
- Quando o `cf_clearance` vence → a consulta volta `status:"erro"` → refaça o `login`.
  O `brk-client.js` trata isso como **UNAVAILABLE e preserva o último valor bom** —
  o badge não quebra.

### Onde hospedar — duas opções

1. **Máquina do cadastro (mais simples):** já tem o Chrome dedicado e um humano
   pode rodar o `login` quando o cf_clearance vencer. O backend na VPS aponta
   `BRK_BASE_URL` para essa máquina (atrás de HTTPS/túnel + allowlist de IP).
2. **Na VPS (container `brk-bot`):** usa o `Dockerfile` daqui (Chromium + Xvfb). O
   bootstrap roda via `docker exec brk-bot xvfb-run -a node refresh_cookies_brk_pw.js login`.
   ⚠️ O Turnstile *interativo* pode exigir VNC no Xvfb; o *managed challenge* costuma
   passar sozinho num Chromium real sob Xvfb — **validar no deploy**.

### Wiring no backend (passo de DEPLOY — propositalmente NÃO aplicado neste PR)

Para não alterar infra em produção sem validação, o `docker-compose.yml` e o
`backend.env` **não** são tocados aqui. No deploy, adicionar ao `docker-compose.yml`
(espelha o `spx-bot`):

```yaml
brk-bot:
  build: { context: ./bots/brasilrisk-robo, dockerfile: Dockerfile }
  image: lamonica-brk-bot:latest
  restart: unless-stopped
  networks: [lamonica-net]
  env_file: [backend.env]
  environment:
    BRK_SIDECAR_HOST: "0.0.0.0"
    BRK_SIDECAR_PORT: "8767"
  volumes:
    - brk_session:/app/backend        # cookie.txt/useragent.txt persistem entre deploys
    - brk_pw_profile:/app/pw_profile  # perfil do Chromium (dispositivo confiável)
  mem_limit: 768m
  expose: ["8767"]
# em volumes:  brk_session: {}   brk_pw_profile: {}
```

E no `backend.env` da VPS (secret nunca no repo):
```
BRK_BASE_URL=http://brk-bot:8767
BRK_API_KEY=<gere forte; a MESMA no brk-bot e no backend>
BRK_SYNC_ENABLED=1      # liga a persistência do badge (default-off)
```
Rollback: `BRK_SYNC_ENABLED=0` desliga sem remover nada.

### Alternativa: allowlist de IP (deixa 100% Node, sem navegador)

Pedir ao Brasil Risk (suporte/gerente de conta) o **allowlist do IP** do host no
Cloudflare/WAF (ou um endpoint/credencial de API oficial). Com o IP liberado,
dispensa Chromium/Xvfb — o `server.js` roda Node puro.
