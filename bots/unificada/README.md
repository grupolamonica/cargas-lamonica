# unificada-robo (API-only)

Gera o **Risk Assessment Document (PDF unificado)** do AngelLira para
motorista + cavalo + carreta consultando a API publica
`https://api.angellira.com.br/profile/query`.

**Sem Selenium**. Tempo medio: ~3-5s (vs ~60-90s do fluxo Selenium printToPDF).

## Instalacao

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edite .env com ANGELIRA_API_USERNAME / ANGELIRA_API_PASSWORD / ANGELIRA_COMPANY_ID
```

## Rodar

```powershell
python run.py
```

Sobe em `http://127.0.0.1:8001`.

## Endpoints

| Metodo | Rota | Funcao |
|--------|------|--------|
| GET    | `/health`                  | Smoke test |
| POST   | `/relatorio/consultar`     | Busca registro por CPF ou placa |
| POST   | `/relatorio/status`        | Status (Conforme / NaoConforme) |
| POST   | `/relatorio/pdf_unificado` | Gera PDF unico (download direto) |

### POST /relatorio/pdf_unificado

```bash
curl -X POST http://127.0.0.1:8001/relatorio/pdf_unificado \
  -H "Content-Type: application/json" \
  -d '{
    "cpf": "12345678909",
    "placa_cavalo": "ABC1234",
    "placa_carreta": "XYZ0987"
  }' \
  -o relatorio.pdf
```

Retorna o `application/pdf` direto. Header `X-Components` indica o status de
cada componente:

```
X-Components: {'motorista': {'found': True, 'status': 'Conforme', ...},
               'cavalo': {'found': True, ...},
               'carreta': {'found': False}}
```

### POST /relatorio/consultar

```bash
curl -X POST http://127.0.0.1:8001/relatorio/consultar \
  -H "Content-Type: application/json" \
  -d '{"query_value": "12345678909", "q_for": "cpf"}'
```

## Como biblioteca Python

```python
import sys
sys.path.insert(0, "backend")

from unificada_robo.relatorio_api_pdf import gerar_pdf_unificado

result = gerar_pdf_unificado(
    cpf="12345678909",
    placa_cavalo="ABC1234",
    placa_carreta="XYZ0987",
    output_path="C:/tmp/relatorio.pdf",
)
print(result)
# {"ok": True, "output_path": "...", "components": {...}, "warnings": [...]}
```

## Estrutura

```
unificada/
├── .env.example
├── README.md
├── requirements.txt
├── run.py
├── static/
│   └── img/angellira-logo.svg     (opcional, usado no header do PDF)
└── backend/
    ├── main.py                     (FastAPI sidecar)
    └── unificada_robo/
        ├── __init__.py
        ├── auth.py                 (creds .env, get_username/password/company_id)
        ├── logger.py
        ├── helpers.py
        ├── relatorio_api.py        (auth + query_profile_records + status)
        └── relatorio_api_pdf.py    (gerar_pdf_unificado via ReportLab)
```

## Auth (igual ao angelira-robo)

```
POST https://auth.angellira.com.br/auth         {login, pass, lang}
POST https://auth.angellira.com.br/auth/grant   {company, user marker}
   -> resposta tem ?access_token=<JWT> na URL ou body.token
GET  https://api.angellira.com.br/profile/query  (Bearer <JWT>)
```

Token cache em memoria com TTL de 20 minutos. Refresh automatico em 401.
