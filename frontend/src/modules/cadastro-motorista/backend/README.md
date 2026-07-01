# Backend — Cadastro de Motorista (FastAPI / Python)

Backend dedicado à tela `/cadastro` (Portal PJ). Encapsula:

- **OCR** de CNH, CRLV, comprovante de residência e cartão CNPJ (via Infosimples ou EasyOCR local).
- **Consultas** de CPF, CNPJ, CEP, ANTT e situação de veículo.
- **Persistência em disco** dos arquivos enviados, organizados por categoria (`motorista/`, `veiculo/`, `proprietario/`).

> Esse backend é totalmente independente do `backend/` Node.js do monorepo (que serve `cargas`/`motoristas`/`leads` via Supabase). O frontend `/cadastro` chama **somente** este FastAPI.

## Estrutura

```
backend/                         ← raiz deste backend Python
├── backend/                     ← código-fonte (módulos Python)
│   ├── main.py                  ← FastAPI app + rotas
│   ├── infosimples.py           ← cliente HTTP da Infosimples
│   ├── config.py                ← lê .env (token, providers)
│   ├── anexo_storage.py         ← grava arquivos enviados em disco
│   └── local_ocr.py             ← OCR offline com EasyOCR
├── run.py                       ← entrypoint dev
├── iniciar.bat                  ← wrapper Windows (instala deps + sobe uvicorn)
├── requirements.txt             ← deps base (FastAPI, httpx)
├── requirements-ocr.txt         ← EasyOCR + torch (download ~600 MB, opcional)
└── .env.example                 ← template de configuração
```

## Como subir (dev)

```bash
# 1) Instalar deps base
pip install -r requirements.txt

# 2) Configurar .env
cp .env.example .env
# editar .env e colar o INFOSIMPLES_TOKEN

# 3) Subir
python run.py
# OU duplo-clique em iniciar.bat (Windows — instala deps + sobe servidor)
```

Servidor sobe em `http://127.0.0.1:8765`. Frontend Vite (porta 8080) tem proxy configurado em [vite.config.ts](../../../../vite.config.ts) que repassa `/api/*` pra cá.

## Variáveis de ambiente (`.env`)

| Variável                    | Obrigatória | Descrição                                              |
|----------------------------|-------------|--------------------------------------------------------|
| `INFOSIMPLES_TOKEN`         | sim         | Token da Infosimples (CNH/CRLV/CNPJ/CEP/ANTT/DETRAN)   |
| `OCR_COMPROVANTE_PROVIDER`  | não         | `infosimples` (padrão) ou `local` (EasyOCR)            |
| `OCR_CARTAO_CNPJ_PROVIDER`  | não         | `local` (padrão) ou `infosimples`                      |

`.env.example` tem todas as opções comentadas.

## Endpoints principais

Consumidos pelo `cadastroApi.ts` do frontend:

| Verbo | Rota                              | Uso                                            |
|-------|-----------------------------------|------------------------------------------------|
| GET   | `/api/status`                     | Health check + flags de provider                |
| POST  | `/api/ocr/cnh`                    | OCR de CNH                                      |
| POST  | `/api/ocr/crlv`                   | OCR de CRLV                                     |
| POST  | `/api/ocr/comprovante-residencia` | OCR de comprovante (Infosimples ou local)       |
| POST  | `/api/ocr/cartao-cnpj`            | OCR de cartão CNPJ                              |
| POST  | `/api/consulta/cpf`               | Dados cadastrais do CPF (Receita Federal)       |
| POST  | `/api/consulta/cnpj`              | Dados cadastrais do CNPJ                        |
| POST  | `/api/consulta/cep`               | Endereço por CEP (Infosimples → ViaCEP fallback) |
| POST  | `/api/consulta/antt`              | Consulta ANTT por CPF/CNPJ/RNTRC                |
| POST  | `/api/consulta/antt-veiculo`      | Situação ANTT do veículo (cascata 5 produtos)   |
| POST  | `/api/consulta/veiculo-situacao`  | Situação do veículo (DETRAN/DENATRAN/SENATRAN)  |
| POST  | `/api/anexo/salvar`               | Persiste arquivo em disco (uso manual)          |
| POST  | `/api/anexo/limpar`               | Apaga pasta de um cadastro                      |
| POST  | `/api/anexo/renomear-pasta`       | Renomeia pasta após OCR da CNH retornar nome    |

Para fluxo passo-a-passo e custos por API, ver [DOCUMENTACAO.md](../DOCUMENTACAO.md).

## Provedor de OCR

`CNH` e `CRLV` **sempre** usam Infosimples (parsers BR-específicos têm precisão muito superior).

Para `comprovante` e `cartão CNPJ`, o `.env` controla via `OCR_*_PROVIDER`:

- `infosimples` — pago (~R$0,20/doc), só funciona com concessionárias do catálogo (CPFL, Enel, Cemig, Light, Energisa, Neoenergia, RGE, Elektro). Limite de 1.5MB por arquivo.
- `local` — EasyOCR offline, gratuito, qualquer documento.

## Estrutura de pastas dos anexos

Após cada cadastro, os arquivos enviados ficam em:

```
backend/anexos_tmp/<nome_motorista_slug>/
├── motorista/         (CNH original + recortes + foto + comprovante)
├── veiculo/           (CRLV cavalo + carreta)
└── proprietario/      (CNH PF / cartão CNPJ PJ + comprovante PF)
```

Detalhes em [DOCUMENTACAO.md § 6](../DOCUMENTACAO.md).
