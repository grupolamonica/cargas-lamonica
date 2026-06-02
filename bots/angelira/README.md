# angelira-robo (API-only)

Cliente Python + sidecar FastAPI para cadastrar **motoristas, proprietarios
e veiculos** no AngelLira via API publica, **sem Selenium**.

Base URL externa: `https://api.angellira.com.br/profile`
Auth: `POST /auth` + `POST /auth/grant` (devolve JWT Bearer).

## Instalacao

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edite .env com seu ANGELIRA_API_USERNAME / ANGELIRA_API_PASSWORD / ANGELIRA_EMPRESA_ID
```

## Rodar

```powershell
python run.py
# ou:
python backend/main.py
```

Sobe em `http://127.0.0.1:8765`.

## Endpoints

| Metodo | Rota | Funcao |
|--------|------|--------|
| GET    | `/api/status`                         | Health + verifica config |
| POST   | `/api/anexo/salvar`                   | Salva anexo base64 em sandbox |
| POST   | `/api/anexo/limpar?id_cadastro=X`     | Remove anexos de um id |
| POST   | `/api/robo/motorista_api/iniciar`     | Cadastra motorista |
| POST   | `/api/robo/proprietario_api/iniciar`  | Cadastra proprietario PF/PJ |
| POST   | `/api/robo/veiculo_api/iniciar`       | Cadastra veiculo cavalo/carreta |
| POST   | `/api/robo/veiculo_api/check_owner`   | Pre-check de divergencia de owner |

## Exemplo: cadastrar motorista

```bash
curl -X POST http://127.0.0.1:8765/api/robo/motorista_api/iniciar \
  -H "Content-Type: application/json" \
  -d '{
    "id_cadastro": "abc123",
    "type_id": 25,
    "payload": {
      "motorista": {
        "nome": "JOAO DA SILVA",
        "cpf": "12345678909",
        "telefone": "85999999999",
        "rg": "1234567",
        "rg_uf": "CE",
        "nascimento": "01/01/1990",
        "mae": "MARIA SILVA"
      },
      "cnh": {
        "numero": "12345678901",
        "categoria": "AB",
        "validade": "01/01/2030",
        "primeira_cnh": "01/01/2010",
        "registro": "12345678901"
      },
      "endereco": {
        "cep": "60150160",
        "logradouro": "RUA DAS PALMEIRAS",
        "numero": "100",
        "complemento": "APTO 5",
        "bairro": "ALDEOTA",
        "cidade": "FORTALEZA",
        "uf": "CE"
      }
    }
  }'
```

## Exemplo: cadastrar proprietario PJ

```bash
curl -X POST http://127.0.0.1:8765/api/robo/proprietario_api/iniciar \
  -H "Content-Type: application/json" \
  -d '{
    "tipo": "PJ",
    "payload": {
      "cnpj": "12345678000199",
      "razao_social": "TRANSPORTES LTDA",
      "telefone": "85999999999",
      "endereco": { "cep": "60150160", ... }
    }
  }'
```

## Exemplo: cadastrar veiculo (cavalo)

```bash
# REGRA ESTRITA: precisa de owner real cadastrado antes (CPF ou CNPJ).
# NUNCA usa fallback generico.
curl -X POST http://127.0.0.1:8765/api/robo/veiculo_api/iniciar \
  -H "Content-Type: application/json" \
  -d '{
    "sub": "cavalo",
    "owner_cnpj": "12345678000199",
    "payload": {
      "placa": "ABC1234",
      "renavam": "12345678901",
      "chassi": "9BWZZZ377VT004251",
      "marca_modelo": "VOLKSWAGEN/CONSTELLATION",
      "ano_fab": 2020,
      "ano_modelo": 2020,
      "cor": "BRANCO",
      "carroceria": "ABERTA"
    }
  }'
```

## Como biblioteca Python

```python
import sys
sys.path.insert(0, "backend")

from angelira_robo.api_query import flow_motorista, flow_proprietario, flow_veiculo
from angelira_robo.api_query.client import get_shared_client

# Cadastra direto sem sidecar
resultado = flow_motorista.cadastrar_motorista(
    payload={"motorista": {...}, "cnh": {...}, "endereco": {...}},
    anexos={},
    type_id=25,
)
print(resultado)
```

## Politicas estritas

- **Veiculo sem owner real → erro 422.** Nao existe fallback generico
  (GRIFFI/TRANSPORTADOR_N0). Cadastre o proprietario antes.
- **Lock por documento.** Double-dispatch concorrente para o mesmo CPF/placa
  serializa via lock — evita duplicacao.
- **Singleton de sessao.** 1 login por processo, JWT refresh automatico em 401.

## Estrutura

```
angelira/
├── .env.example
├── README.md
├── requirements.txt
├── run.py
└── backend/
    ├── main.py
    ├── config.py
    ├── anexo_storage.py
    └── angelira_robo/
        ├── __init__.py
        ├── auth.py            (criar_sessao_api + creds .env)
        ├── helpers.py
        ├── logger.py
        ├── precheck_types.py
        └── api_query/
            ├── __init__.py
            ├── client.py      (AngellraAPIClient + singleton)
            ├── drivers.py     (POST/PATCH /drivers)
            ├── owners.py      (POST/PATCH /owners)
            ├── vehicles.py    (POST/PATCH /vehicles)
            ├── geo.py         (CEP, UF -> IDs)
            ├── mapping.py     (carroceria, etc)
            ├── queries.py     (store_query helpers)
            ├── precheck.py    (verificar_motorista_via_api, verificar_veiculo_via_api)
            ├── flow_motorista.py
            ├── flow_proprietario.py
            └── flow_veiculo.py
```
