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
