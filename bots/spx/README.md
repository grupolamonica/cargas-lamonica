# spx-robo — cliente Python da API interna do SPX (Shopee Express BR)

Cliente HTTP direto pra cadastrar motoristas no portal de Agencias SPX
(`logistics.myagencyservice.com.br`) **sem precisar abrir navegador**.

Espelha o padrao do `angelira-robo` (sidecar FastAPI + biblioteca Python).

---

## Como funciona

```
Painel Node (bot_cadastro.js)
        │
        │ HTTP POST /spx/motorista
        ▼
spx-robo sidecar FastAPI (porta 8766)
        │
        │ Cookies + headers (device-id, app, version)
        ▼
https://logistics.myagencyservice.com.br/api/driverservice/...
```

## Pre-requisitos

1. **Python 3.10+**
2. **Operador logado no portal SPX no Chrome** (vide passo "Cookies")
3. Acesso de Agencia (id da agencia = `297` no nosso caso)

## Instalacao

```powershell
cd "Sistema_cadastro (reserva)/spx-robo"
python -m venv .venv
.venv/Scripts/Activate.ps1
pip install -r requirements.txt
cp .env.example .env
```

## Configurar `.env`

Preencha pelo menos:

```ini
SPX_COOKIE_FILE=config/spx_cookies.json
SPX_DEVICE_ID=<32 chars hex do localStorage["device-id"] do portal>
SPX_VERSION=<copiar valor exato do header "version" de qualquer request do portal>
SPX_AGENCY_ID=297
```

### Como pegar `SPX_DEVICE_ID` e `SPX_VERSION`

No portal logado, abra DevTools (F12) → Console:

```js
console.log("device-id:", localStorage.getItem("device-id"));
```

Pro `version`: F12 → Network → clique em qualquer request `/api/...` →
copie o valor do header `version` (string longa, ~250 chars).

## Cookies (auth)

A API SPX usa cookies HTTPOnly setados via SSO. **Nao ha endpoint
programatico de login**. Voce precisa exportar os cookies do Chrome:

### Opcao A — extensao Cookie Editor (recomendado)

1. Chrome Web Store → instale "Cookie-Editor"
2. Estando no portal SPX logado, clique no icone da extensao
3. Botao **Export** → formato **JSON**
4. Cole o JSON em `config/spx_cookies.json`

### Opcao B — DevTools manual

1. F12 → aba **Application** → Cookies → `https://logistics.myagencyservice.com.br`
2. Para cada cookie, monte um JSON manualmente:

```json
[
  {"name":"SPC_SC_SESSION","value":"...","domain":".myagencyservice.com.br","path":"/","secure":true,"httpOnly":true,"expirationDate":1779999999},
  {"name":"_csrftoken","value":"...","domain":".myagencyservice.com.br","path":"/"}
]
```

3. Salve em `config/spx_cookies.json`

**Quando expirarem (~horas/dias)**, exporte de novo e chame:

```
POST http://127.0.0.1:8766/spx/session/reset
```

## Uso

### Sidecar FastAPI (recomendado — integra com bot_cadastro.js)

```powershell
python backend/main.py
```

Sobe em `http://127.0.0.1:8766`. Endpoints:

```
GET  /spx/health                            Smoke test sessao
GET  /spx/lookups/vehicle_types             19 tipos
GET  /spx/lookups/cities?name=Fortaleza
GET  /spx/lookups/stations                  Hubs da agencia
GET  /spx/lookups/attributes
POST /spx/motorista/busca       {cpf}       is_cpf_exist (rapido)
POST /spx/motorista              ...         Cria novo cadastro
POST /spx/motorista/atualizar    ...         Edita request existente (preserva locked_fields)
GET  /spx/requests/list?cpf=X               Lista driver_requests
GET  /spx/requests/{id}                     Detalhe da request
POST /spx/requests/{id}/withdraw            Cancela request
POST /spx/session/reset                     Recarrega cookies apos re-exportar
```

### Fluxo "request ja existe" (RECOMENDADO)

Quando o motorista ja tem uma `driver_request` (rejeitada, em revisao, ou aprovada
mas precisando ajuste), `POST /spx/motorista` retorna:

```json
{
  "ok": false, "etapa": "request_pendente",
  "retcode": 271605028,
  "existing_request_id": 322675,
  "erro": "Ja existe solicitacao aberta..."
}
```

O painel deve detectar isso e oferecer "Editar". Pra editar, use:

```bash
# 1) ver o que esta na request
curl http://127.0.0.1:8766/spx/requests/322675

# 2) re-submeter com nova selfie (preserva resto)
curl -X POST http://127.0.0.1:8766/spx/motorista/atualizar \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": 322675,
    "novo_driver_photo_path": "C:/uploads/tiago_selfie_color.jpg",
    "overrides": {"vehicle_owner_name": "Nome corrigido"}
  }'
```

O endpoint **preserva automaticamente os locked_fields** (cpf, license_number, etc).
Use `dry_run: true` pra ver o payload final sem submeter.

### Como biblioteca Python (uso direto)

```python
from spx_robo.client import SPXClient
from spx_robo import flow_motorista, constants as K

client = SPXClient()
if not client.ping():
    raise SystemExit("sessao invalida — reexporte cookies")

result = flow_motorista.cadastrar_motorista_normal(
    client,
    cpf="12345678909",
    driver_name="FULANO DE TAL",
    contact_number="85999999999",
    gender=K.Gender.MALE,
    birth_day="1990-01-15",
    city_name="Fortaleza",
    neighbourhood_name="ALDEOTA",
    street_name="RUA DAS PALMEIRAS",
    address_number="123",
    zip_code="60150160",
    contract_type=1,
    function_type_list=[K.FunctionType.LINE_HAUL],
    linehaul_station_name="SoC_RJ_Rio de Janeiro",
    license_number="12345678901",
    license_type=K.CNHType.E,
    license_expire_date="2030-01-01",
    cnh_remarks=["EAR"],
    vehicle_type_name="TRUCK - EXPRESSA",
    license_plate="ABC1234",
    vehicle_manufacturer="VOLKSWAGEN",
    vehicle_manufacturing_year="2020",
    vehicle_owner_name="FULANO DE TAL",
    renavam="12345678901",
    cnh_frente_path="C:/uploads/cnh_frente.jpg",
    cnh_verso_path="C:/uploads/cnh_verso.jpg",
    selfie_path="C:/uploads/selfie.jpg",
    crlv_path="C:/uploads/crlv.pdf",
    dry_run=False,  # True pra so montar payload e ver o que iria enviar
)
print(result)
# {"ok": True, "etapa": "completo", "request_id": ..., "driver_id": ...}
```

Veja `examples/cadastrar_motorista.py` para um exemplo completo com `dry_run=True`.

## Estrutura

```
spx-robo/
├── README.md
├── requirements.txt
├── .env.example
├── config/
│   └── spx_cookies.json    (gitignored — voce cria)
├── backend/
│   ├── main.py             FastAPI sidecar (porta 8766)
│   └── spx_robo/
│       ├── __init__.py
│       ├── auth.py         load_cookies, validacao
│       ├── client.py       SPXClient (HTTP wrapper)
│       ├── constants.py    retcodes, enums (TransportType, CNHType, ...)
│       ├── lookups.py      vehicle_types, cities, stations (cached)
│       ├── uploads.py      multipart (CNH, RG, CRLV+OCR, selfie)
│       ├── drivers.py      validate, draft, submit, list, detail
│       ├── flow_motorista.py  orquestracao end-to-end
│       └── logger.py
└── examples/
    └── cadastrar_motorista.py
```

## Endpoints SPX usados (referencia rapida)

| Funcao | Endpoint |
|---|---|
| Validate basico (CPF) | `POST /api/driverservice/agency/br/driver/request/validate/basic` |
| Validate detalhe | `POST .../request/validate/detail` |
| Salvar rascunho | `POST .../request/draft/save` |
| Pre-submit | `POST .../request/submit/check` |
| **Submit final** | `POST .../request/submit` |
| Listar pedidos | `POST .../request/list` |
| Detalhe pedido | `POST .../request/detail` |
| Sacar pedido | `POST .../request/withdraw` |
| Upload CNH | `POST .../request/upload/image` ou `/upload/license` |
| Upload RG (walker) | `POST .../request/upload/rg_photo` |
| Upload selfie | `POST .../driver/driver_photo/upload` |
| CRLV + OCR | `POST .../request/vehicle_doc/recognition` |
| Lista tipos veiculo | `GET /api/fleet_management/agency/type/search` |
| Stations da agencia | `POST /api/driverservice/agency/br/function_station_list` |
| Search cidades | `GET /api/networkroute/agency/address_management/search_cities` |

## Locked fields (nao editaveis em requests existentes)

Quando ha uma request criada, esses campos NAO podem ser sobrescritos por `atualizar`:
- `cpf`, `license_type`, `driver_name`, `license_number`
- `license_img_front`, `license_img_back`
- `license_expire_date`, `birth_day`

O detail da request tambem traz `locked_fields[]` proprio do backend; o cliente
faz a uniao com os defaults e ignora tentativas de mudanca (loga aviso).

## Sensitive fields (mascarados em respostas)

Esses campos vem `""` ou mascarados nas respostas de `list`/`detail/view`:
- `cpf`, `contact_number`, `license_number`, `driver_name`, `driver_email`
- `driver_photo`, `license_img_front/back`, `rg_photo_url_list`
- `card_number`, `account_name`, `account_number`, `bank_name`
- `image`, `base_photo_url`, `license_photo_url`, `risk_assessment_document`

Pra ver o valor real, use `GET /api/driverservice/agency/br/driver/request/sensitive/get`
(passar o id da request). O backend log essa consulta. O `view_only=false` em
`get_request_detail` ja desbloqueia alguns deles (ja usado por `atualizar`).

## Codigos de erro conhecidos

| retcode | Significado |
|---|---|
| 0 | Sucesso |
| 271605007 | CPF invalido |
| 271605009 | Telefone invalido (PHONE_INVALID) |
| 271605028 | Ja existe solicitacao aberta (REQUEST_IN_PROGRESS) — use /atualizar |
| 271627140 | CPF ja cadastrado (DRIVER_REPEAT) |
| 271617003 | Motorista bloqueado (DRIVER_BLOCKED) |
| 991900001 | OCR nao extraiu CRLV |
| 991900013/14/16/18 | Erros de upload (backend / tipo / tamanho / formato) |

Veja `spx_robo/constants.py` para a lista completa.

## Integracao com bot_cadastro.js

No `bot_cadastro.js`, adicione algo como:

```js
const SPX_BASE = 'http://127.0.0.1:8766';

async function cadastrarSPX(motorista) {
  const r = await fetch(`${SPX_BASE}/spx/motorista`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(motorista),
  });
  return r.json();
}
```

E pode trocar o badge "SPX" manual no painel pelo disparo automatico
(igual feito com Angellira).

## Limitacoes conhecidas

- **Sessao expira**. Reexportar cookies periodicamente. Sintoma:
  401/redirect pra `accounts.myagencyservice.com.br/login`. Detector
  lanca `SessaoExpirada`. Refaca a exportacao e chame `/spx/session/reset`.
- **Sem login programatico**. Bundle do portal nao expoe endpoint de
  credenciais; auth eh totalmente cookie-based via SSO.
- **OCR do CRLV pode errar**. `ocr_result != 0` retorna aviso; preencha
  manualmente.
- **Schema do payload eh derivado do bundle JS** (source map exposto).
  Pequenas mudancas do portal podem quebrar — versione cuidadosamente.

## Status

- [x] Cliente HTTP + auth via cookies (validado em prod 2026-05-21)
- [x] Lookups (vehicle_types, cities, stations, attributes)
- [x] Uploads (CNH, RG, selfie, CRLV+OCR, risk_doc)
- [x] Validate basic + detail
- [x] Submit (check + final)
- [x] Sidecar FastAPI rodando (porta 8766)
- [x] **Cliente validado E2E com agencia 297 (LAMONICA)**
- [x] Fluxo "editar request existente" (atualizar)
- [x] Endpoints requests/list, requests/{id}, withdraw
- [x] Tratamento de retcode 271605028 (request pendente)
- [ ] Integrar com `bot_cadastro.js`
- [ ] Selfie/CRLV upload com motorista real (faltou testar fim-a-fim com submit=true)
- [ ] Login programatico (Playwright headless) — opcional, hoje exporta cookies manual
