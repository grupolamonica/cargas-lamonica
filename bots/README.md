# bots/ — Sidecars de cadastro (API-only)

Conjunto de **3 sidecars FastAPI independentes** que automatizam o cadastro
de motoristas, proprietários e veículos nos sistemas externos (Angellira,
SPX/Shopee Express). **Toda a lógica de Selenium foi removida** — apenas
chamadas HTTPS para APIs públicas.

Versionados no monorepo a partir do **Epic DC-111** (movidos de
`api-only-export/` em 2026-05-28 / DC-112).

## Servicos

| Pasta | Porta | Funcao | Auth externa |
|-------|-------|--------|--------------|
| [`angelira/`](angelira/) | 8765 | Cadastra **motorista**, **proprietario** e **veiculo** no AngelLira via API publica | `POST /auth` + `/auth/grant` (JWT Bearer) |
| [`spx/`](spx/)           | 8766 | Cadastra **motorista** no portal Shopee Express (SPX) | Cookies HTTPOnly exportados do Chrome |
| [`unificada/`](unificada/)| 8001 | Gera **PDF Risk Assessment Document** unificado (motorista + cavalo + carreta) a partir da API AngelLira | Reusa JWT do AngelLira (mesmas creds) |

Cada servico e **standalone**: pasta propria, `.env`, `requirements.txt`,
`run.py`, README. Voce pode subir os 3 ou so um.

## Pre-requisitos

- Python 3.10+
- Credenciais do portal AngelLira (usuario + senha + empresa_id)
- Cookies exportados do portal SPX (para o sidecar SPX)

## Como usar

Cada servico segue o mesmo padrao:

```powershell
cd <angelira|spx|unificada>
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edita .env com suas credenciais
python run.py
```

Detalhes especificos no README de cada pasta.

## Diferenca-chave: o que mudou em relacao ao projeto original

| Original | Aqui (API-only) |
|----------|-----------------|
| `bot_cadastro.js` (Node) orquestrava | Cada sidecar e standalone — chame direto via HTTP |
| `angelira-robo` tinha Selenium + API | So API. Selenium completamente removido |
| `unificada-robo` baixava PDF via Chrome (`baixar_pdf_relatorio.py`) | Gera PDF via ReportLab a partir da API (3-5s vs ~90s) |
| `spx-robo` ja era API-only | Identico, apenas extraido |
| Dependia de `.env` raiz + locais + `secret_manager` DPAPI | Cada sidecar le so o `.env` ao seu lado |
| Logger hub HTTP + JSONL estruturado + execution_context | Logger simples: stdout + arquivo rotativo |
| Integracao com Google Sheets (gspread) | Removida — APIs de cadastro nao dependem mais disso |
| Endpoints de OCR (Infosimples) | Removidos — o sidecar so cadastra, OCR fica com o cliente |

## Pipeline de cadastro completo (referencia)

```
[CLIENTE: bot / painel / curl / script]
   │
   ├─► HTTP POST http://127.0.0.1:8765/api/robo/proprietario_api/iniciar
   │     └─► angelira-robo  ─HTTPS─►  api.angellira.com.br/profile/owners
   │
   ├─► HTTP POST http://127.0.0.1:8765/api/robo/veiculo_api/iniciar
   │     └─► angelira-robo  ─HTTPS─►  api.angellira.com.br/profile/vehicles
   │
   ├─► HTTP POST http://127.0.0.1:8765/api/robo/motorista_api/iniciar
   │     └─► angelira-robo  ─HTTPS─►  api.angellira.com.br/profile/drivers
   │
   ├─► HTTP POST http://127.0.0.1:8766/spx/motorista
   │     └─► spx-robo       ─HTTPS─►  logistics.myagencyservice.com.br/api/driverservice/...
   │
   └─► HTTP POST http://127.0.0.1:8001/relatorio/pdf_unificado
         └─► unificada-robo ─HTTPS─►  api.angellira.com.br/profile/query
                                 └─► PDF (Risk Assessment Document)
```

## Documento tecnico

Para entender em detalhe **como o cadastro funciona** (auth, payloads,
sequencia de chamadas, locks, edge cases), leia
[`RELATORIO_CADASTRO.md`](RELATORIO_CADASTRO.md).
