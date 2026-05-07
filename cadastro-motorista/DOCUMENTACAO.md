# Sistema de Cadastro de Motorista — Documentação

Documento operacional do módulo `cadastro-motorista`. Cobre arquitetura, fluxo, endpoints, custos por API e troubleshooting.

> Última atualização: 2026-05-05

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Fluxo de cadastro (passo a passo)](#3-fluxo-de-cadastro-passo-a-passo)
4. [Endpoints internos do backend](#4-endpoints-internos-do-backend)
5. [APIs externas consumidas e custos](#5-apis-externas-consumidas-e-custos)
6. [Estrutura de pastas resultante](#6-estrutura-de-pastas-resultante)
7. [Variáveis de ambiente](#7-variáveis-de-ambiente)
8. [Códigos de erro mais comuns](#8-códigos-de-erro-mais-comuns)
9. [Limpeza e TTL de anexos](#9-limpeza-e-ttl-de-anexos)
10. [Como rodar localmente](#10-como-rodar-localmente)

---

## 1. Visão geral

A tela `/cadastro` é um **portal público PJ** com 5 etapas (Motorista → Cavalo → Carreta → Operacional → Proprietário) onde o motorista anexa documentos (CNH, CRLV, comprovante, cartão CNPJ ou CNH do proprietário PF) e o sistema:

- **Extrai dados via OCR** (Infosimples para CNH/CRLV; EasyOCR local para comprovante/cartão CNPJ);
- **Consulta APIs públicas** (Receita Federal, ANTT, DENATRAN, Correios) para validar e enriquecer;
- **Persiste arquivos em disco** numa pasta nomeada com o nome do motorista, separados em subpastas semânticas (`motorista/`, `veiculo/`, `proprietario/`).

O escopo do módulo é exclusivamente esse cadastro. Não inclui automação de portais externos nem export para planilhas — esses fluxos rodam fora do módulo.

---

## 2. Arquitetura

### Frontend

Componente React em [`CadastroDocumentos.tsx`](./CadastroDocumentos.tsx) com cliente HTTP em [`cadastroApi.ts`](./cadastroApi.ts).

**Stack:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui.
**Rota:** `/cadastro` (lazy-loaded em [`App.tsx`](../../App.tsx)).

### Backend

FastAPI Python em [`backend/`](./backend/), porta `:8765`.

| Arquivo                          | Papel                                                       |
|----------------------------------|-------------------------------------------------------------|
| `backend/backend/main.py`        | App FastAPI com todas as rotas (OCR, consultas, anexos)     |
| `backend/backend/infosimples.py` | Cliente HTTP da Infosimples                                 |
| `backend/backend/local_ocr.py`   | OCR local com EasyOCR (offline)                             |
| `backend/backend/anexo_storage.py` | Persistência em disco com sandbox/categorias              |
| `backend/backend/config.py`      | Configuração (lê `.env`)                                    |

### Fluxo de rede

```
Browser            Vite (8080)          FastAPI (8765)         APIs externas
─────────          ───────────          ──────────────         ─────────────
fetch /api/* ──▶   proxy /api/*  ──▶   rota interna   ──▶   api.infosimples.com
                                                            viacep.com.br (fallback)
```

O Vite tem proxy configurado pra repassar `/api/*` direto pro `:8765`.

---

## 3. Fluxo de cadastro (passo a passo)

### Passo 1 — Mount da página `/cadastro`

| Ação | Backend? | Custo |
|---|---|---|
| Gera `id_cadastro` único (`cad_<timestamp>_<random>`) | Não (frontend) | gratuito |

Esse id é o nome inicial da pasta em `anexos_tmp/`. Após o passo 2 (OCR da CNH) ele é renomeado pro nome do motorista.

### Passo 2 — Upload da CNH do motorista

```
Frontend                       Backend                       Infosimples
────────                       ───────                       ───────────
ocrCnh(file, idCadastro) ─▶  POST /api/ocr/cnh ──────▶  POST /api/v2/imagens/ocr/cnh
                              │
                              ├─ Salva original em
                              │  <id>/motorista/cnh_motorista.<ext>
                              │
                              ├─ Recebe resposta da Infosimples
                              │
                              ├─ Salva frente recortada em
                              │  <id>/motorista/cnh_motorista_frente.jpg
                              ├─ Salva verso recortado em
                              │  <id>/motorista/cnh_motorista_verso.jpg
                              ├─ Salva foto 3x4 em
                              │  <id>/motorista/foto_motorista.jpg
                              │
                              ├─ Renomeia <id>/ → <nome-motorista>/
                              │
                              └─ Retorna JSON + id_cadastro_pasta
```

| Endpoint Infosimples | Custo  | O que extrai                                                   |
|---------------------|--------|----------------------------------------------------------------|
| `imagens/ocr/cnh`    | R$ 0,10| Nome, CPF, RG, nascimento, filiação, categoria, validade, registro, espelho, observações, foto, assinatura |

Ao final deste passo, a pasta já está com o nome do motorista (ex: `fernando_jose_da_silva/motorista/`) e contém 4 arquivos.

### Passo 3 — Upload do comprovante de residência (motorista)

```
Frontend                       Backend                       OCR Provider
────────                       ───────                       ────────────
ocrComprovante(file, ─────▶  POST /api/ocr/      ──────▶  EasyOCR local (default)
  concessionaria,            comprovante-residencia       OU Infosimples ocr/contas-{conc}
  idCadastro)                  │
                               └─ Salva em <nome>/motorista/comprovante_motorista.<ext>
```

| Provider              | Custo            | Recomendação                                                  |
|----------------------|------------------|---------------------------------------------------------------|
| `local` (EasyOCR)     | gratuito         | Default. Funciona com qualquer comprovante BR.                |
| `infosimples` (paga)  | R$ 0,15–0,30     | Só funciona com 8 concessionárias (CPFL, Enel, Cemig, Light, Energisa, Neoenergia, RGE, Elektro). Limite 1.5 MB. |

Após extrair o CEP, dispara automaticamente o passo 4.

### Passo 4 — Auto-consulta CEP

| Endpoint            | Custo Infosimples | Fallback              |
|--------------------|-------------------|-----------------------|
| `correios/cep`      | ~R$ 0,02          | ViaCEP (gratuito)     |

UF/cidade/bairro/logradouro vêm do CEP (mais confiável que OCR); o número fica o que o OCR achou.

### Passo 5 — Upload CRLV do cavalo

```
ocrCrlv(file, idCadastro) ─▶  POST /api/ocr/crlv ──────▶  POST /api/v2/imagens/ocr/crlv
                                  │
                                  └─ Salva em <nome>/veiculo/crlv_cavalo.<ext>
```

| Endpoint               | Custo  |
|-----------------------|--------|
| `imagens/ocr/crlv`     | R$ 0,10|

Extrai: placa, RENAVAM, chassi, tipo, marca/modelo, ano, cor, eixos, ANTT/RNTRC, último licenciamento, **CPF ou CNPJ do proprietário**, nome do proprietário.

Se o CRLV trouxer CNPJ, dispara o passo 5.1 automaticamente; se trouxer CPF, libera o upload da CNH do proprietário PF (passo 10).

### Passo 5.1 — Auto-consulta CNPJ (proprietário PJ)

| Endpoint                | Custo  |
|-------------------------|--------|
| `receita-federal/cnpj`  | R$ 0,30|

Devolve: razão social, nome fantasia, endereço completo, situação cadastral, CNAE, sócios, capital. Preenche bloco "Proprietário PJ".

### Passo 6 — Auto-consulta ANTT do veículo

Backend faz cascata até obter sucesso:

```
1) antt/transportador {cpf}        ─ se TAC
2) antt/transportador {cnpj}       ─ se ETC/CTC
3) antt/veiculo {placa}            ─ placa-only
4) antt/registro-rntrc {placa}     ─ variante alternativa
5) antt/consulta-rntrc {placa+doc} ─ último recurso
```

| Endpoint                 | Custo (cada chamada que retorna 200) |
|-------------------------|--------------------------------------|
| `antt/transportador`     | R$ 0,30                              |
| `antt/veiculo`           | R$ 0,40                              |
| `antt/registro-rntrc`    | R$ 0,30                              |
| `antt/consulta-rntrc`    | R$ 0,40                              |

> Falhas (404, timeout) **não são `billable`**. Só a primeira chamada com `code: 200` é cobrada.

### Passo 7 — Auto-consulta situação do veículo (DETRAN/DENATRAN)

```
1) detran-{uf}/restricoes-veiculo  (se UF + RENAVAM)
2) detran-{uf}/situacao-veiculo    (se UF + RENAVAM)
3) denatran/restricoes-veiculo
4) senatran/sinesp-cidadao         (último recurso)
```

| Endpoint                          | Custo (estimado)         |
|----------------------------------|--------------------------|
| `detran-<uf>/restricoes-veiculo`  | R$ 0,80–1,50 (varia UF)  |
| `detran-<uf>/situacao-veiculo`    | R$ 0,80–1,50 (varia UF)  |
| `denatran/restricoes-veiculo`     | R$ 0,40                  |
| `senatran/sinesp-cidadao`         | R$ 0,15 (dados básicos)  |

### Passo 8 — Upload CRLV da carreta

Idêntico ao passo 5, mas com sufixo `:carreta` no `id_cadastro`. Salvo em `<nome>/veiculo/crlv_carreta.<ext>`. Dispara as mesmas consultas (CNPJ, ANTT, DETRAN) para a carreta se proprietário diferente do cavalo.

### Passo 9 — Upload do cartão CNPJ (proprietário PJ)

```
ocrCartaoCnpj(file, idCadastro) ─▶  POST /api/ocr/cartao-cnpj
                                       │
                                       └─ Salva em <nome>/proprietario/cartao_cnpj.<ext>
```

| Provider              | Custo     |
|----------------------|-----------|
| `local` (EasyOCR)     | gratuito  |
| `infosimples` (paga)  | R$ 0,10   |

Para carreta com proprietário diferente, sufixo `:carreta` → `proprietario/cartao_cnpj_carreta.<ext>`.

### Passo 10 — (Alternativo) Upload da CNH do proprietário PF

Quando CRLV trouxer CPF (não CNPJ). Funciona como o passo 2, com sufixo `:proprietario`:

- Original em `<nome>/proprietario/cnh_proprietario.<ext>`
- Frente em `<nome>/proprietario/cnh_proprietario_frente.jpg`
- Verso em `<nome>/proprietario/cnh_proprietario_verso.jpg`
- Foto **não é salva** (só pra motorista — define o nome da pasta).

| Endpoint            | Custo  |
|--------------------|--------|
| `imagens/ocr/cnh`   | R$ 0,10|

### Passo 11 — Comprovante de residência do proprietário PF

Igual ao passo 3, com sufixo `:proprietario`. Salvo em `<nome>/proprietario/comprovante_proprietario.<ext>`.

### Passo 12 — Auto-consulta CPF do proprietário PF

| Endpoint                | Custo  |
|------------------------|--------|
| `receita-federal/cpf`   | R$ 0,15|

Devolve: nome completo, situação cadastral, data de inscrição.

---

## 4. Endpoints internos do backend

Servidor em `http://127.0.0.1:8765`. Todas as rotas prefixadas com `/api`.

### OCR (`/api/ocr/*`)

| Rota                                 | Body                                                                     | Comportamento                                |
|-------------------------------------|--------------------------------------------------------------------------|----------------------------------------------|
| `POST /api/ocr/cnh`                  | `{imagem, id_cadastro?}` (`:proprietario` → CNH do dono PF)              | Salva CNH + recortes + auto-rename pasta     |
| `POST /api/ocr/crlv`                 | `{imagem, id_cadastro?}` (`:carreta` → carreta)                          | Salva CRLV cavalo ou carreta                 |
| `POST /api/ocr/comprovante-residencia` | `{imagem, concessionaria, id_cadastro?}` (`:proprietario`)             | Salva comprovante motorista ou proprietário  |
| `POST /api/ocr/cartao-cnpj`          | `{imagem, id_cadastro?}` (`:carreta`)                                    | Salva cartão CNPJ cavalo ou carreta          |

> **Sufixos no `id_cadastro`** (não persistem no nome da pasta — são roteadores):
> - `:carreta` → distingue cavalo de carreta no CRLV/cartão CNPJ
> - `:proprietario` → distingue motorista de proprietário PF na CNH/comprovante

### Consultas (`/api/consulta/*`)

| Rota                              | Body                          | Produto Infosimples                   |
|----------------------------------|-------------------------------|---------------------------------------|
| `POST /api/consulta/cpf`          | `{cpf, nascimento}`           | `receita-federal/cpf`                 |
| `POST /api/consulta/cnpj`         | `{cnpj}`                      | `receita-federal/cnpj`                |
| `POST /api/consulta/cep`          | `{cep}`                       | `correios/cep` + ViaCEP (fallback)    |
| `POST /api/consulta/antt`         | `{cnpj, rntrc, cpf}`          | `antt/transportador`                  |
| `POST /api/consulta/antt-veiculo` | `{placa, cpf?, cnpj?}`        | cascata de 5 produtos ANTT            |
| `POST /api/consulta/veiculo-situacao` | `{placa, renavam?, uf?}`  | cascata DETRAN/DENATRAN/SENATRAN      |

### Anexos (`/api/anexo/*`)

| Rota                                | Body                                       |
|------------------------------------|--------------------------------------------|
| `POST /api/anexo/salvar`            | `{tipo, imagem, id_cadastro}`              |
| `POST /api/anexo/limpar`            | `?id_cadastro=...`                         |
| `POST /api/anexo/renomear-pasta`    | `{id_cadastro, nome_motorista}`            |

### Status

| Rota                | Body | Resposta                                                        |
|--------------------|------|-----------------------------------------------------------------|
| `GET /api/status`   | —    | `{ok, token_configurado, providers}` — health check do backend  |

---

## 5. APIs externas consumidas e custos

### Infosimples — Tabela consolidada

> Preços em **R$ por chamada bem-sucedida (`code: 200`)**. Falhas não cobram. Valores de referência — confirme no painel Infosimples (`https://api.infosimples.com/painel`) para sua conta.

| Produto                             | Custo (R$) | Quando dispara                                     |
|------------------------------------|-----------|----------------------------------------------------|
| `imagens/ocr/cnh`                   | 0,10      | Upload CNH (motorista ou proprietário)             |
| `imagens/ocr/crlv`                  | 0,10      | Upload CRLV (cavalo ou carreta)                    |
| `imagens/ocr/cnpj`                  | 0,10      | Upload cartão CNPJ se provider=infosimples         |
| `imagens/ocr/contas-{concessionaria}` | 0,15–0,30 | Upload comprovante se provider=infosimples         |
| `correios/cep`                      | 0,02      | Auto-consulta CEP                                  |
| `receita-federal/cpf`               | 0,15      | Validação CPF + data de nascimento                 |
| `receita-federal/cnpj`              | 0,30      | CRLV trouxer CNPJ do proprietário                  |
| `antt/transportador`                | 0,30      | Auto-consulta ANTT por CPF/CNPJ/RNTRC              |
| `antt/veiculo`                      | 0,40      | Fallback ANTT por placa                            |
| `antt/registro-rntrc`               | 0,30      | Fallback ANTT alternativo                          |
| `antt/consulta-rntrc`               | 0,40      | Último fallback ANTT (placa + doc)                 |
| `detran-<uf>/restricoes-veiculo`    | 0,80–1,50 | Auto-consulta DETRAN se UF + RENAVAM disponíveis   |
| `detran-<uf>/situacao-veiculo`      | 0,80–1,50 | Variante alternativa                               |
| `denatran/restricoes-veiculo`       | 0,40      | Fallback DENATRAN nacional                         |
| `senatran/sinesp-cidadao`           | 0,15      | Último fallback (dados básicos)                    |

### Custo total típico por cadastro

**Motorista PF + cavalo PJ + carreta PJ (cenário comum):**

| Etapa                                  | Custo R$ |
|---------------------------------------|----------|
| OCR CNH motorista                       | 0,10     |
| OCR comprovante motorista (local)       | 0,00     |
| Consulta CEP                             | 0,02     |
| OCR CRLV cavalo                          | 0,10     |
| Consulta CNPJ proprietário cavalo        | 0,30     |
| Consulta ANTT cavalo (1 produto OK)      | 0,30     |
| Consulta DETRAN/DENATRAN cavalo (1 OK)   | 0,40–1,50|
| OCR CRLV carreta                         | 0,10     |
| Consulta CNPJ proprietário carreta       | 0,30     |
| Consulta ANTT carreta                    | 0,30     |
| Consulta DETRAN/DENATRAN carreta         | 0,40–1,50|
| OCR cartão CNPJ (local)                  | 0,00     |
| **Total estimado**                       | **R$ 2,32 a 4,52** |

**Motorista é dono PF (cenário mínimo):**

| Etapa                          | Custo R$ |
|-------------------------------|----------|
| OCR CNH motorista              | 0,10     |
| OCR comprovante (local)        | 0,00     |
| Consulta CEP                    | 0,02     |
| Consulta CPF                    | 0,15     |
| OCR CRLV                        | 0,10     |
| Consulta ANTT TAC               | 0,30     |
| Consulta DENATRAN               | 0,40     |
| **Total**                       | **~R$ 1,07** |

### APIs gratuitas

- **ViaCEP** — fallback de CEP. Sem rate limit oficial, recomendado <30 req/s.
- **EasyOCR (local)** — comprovante e cartão CNPJ. Modelos baixados uma única vez (~600 MB) na primeira execução.

---

## 6. Estrutura de pastas resultante

```
backend/anexos_tmp/
└── <nome_motorista_slug>/                    ex: fernando_jose_da_silva/
    ├── motorista/
    │   ├── cnh_motorista.<ext>               ← original (PDF/JPG enviado)
    │   ├── cnh_motorista_frente.jpg          ← frente recortada pela Infosimples
    │   ├── cnh_motorista_verso.jpg           ← verso recortado
    │   ├── foto_motorista.jpg                ← foto 3x4 do portador
    │   ├── comprovante_motorista.<ext>
    │   └── rg_motorista.<ext>                ← opcional
    │
    ├── veiculo/
    │   ├── crlv_cavalo.<ext>
    │   └── crlv_carreta.<ext>                ← se composição "1 cavalo + 1 carreta"
    │
    └── proprietario/
        ├── cartao_cnpj.<ext>                 ← se proprietário cavalo é PJ
        ├── cartao_cnpj_carreta.<ext>         ← se carreta tem proprietário PJ diferente
        ├── cnh_proprietario.<ext>            ← se proprietário cavalo é PF
        ├── cnh_proprietario_frente.jpg
        ├── cnh_proprietario_verso.jpg
        ├── comprovante_proprietario.<ext>    ← se PF
        └── rg_proprietario.<ext>             ← opcional
```

### Mapeamento `tipo` → categoria

Definido em [`backend/anexo_storage.py`](./backend/backend/anexo_storage.py) — fonte única de verdade:

```python
TIPO_PARA_CATEGORIA = {
    # motorista/
    "cnh_motorista":              "motorista",
    "cnh_motorista_frente":       "motorista",
    "cnh_motorista_verso":        "motorista",
    "foto_motorista":             "motorista",
    "rg_motorista":               "motorista",
    "comprovante_motorista":      "motorista",
    # veiculo/
    "crlv_cavalo":                "veiculo",
    "crlv_carreta":               "veiculo",
    # proprietario/
    "cnh_proprietario":           "proprietario",
    "cnh_proprietario_frente":    "proprietario",
    "cnh_proprietario_verso":     "proprietario",
    "rg_proprietario":            "proprietario",
    "comprovante_proprietario":   "proprietario",
    "cartao_cnpj":                "proprietario",
    "cartao_cnpj_carreta":        "proprietario",
}
```

### Sandbox de segurança

- Todos os paths são **resolvidos para dentro de `ANEXOS_DIR`** (`backend/anexos_tmp/`).
- IDs de cadastro são validados pela regex `^[A-Za-z0-9_\-]{1,64}$`.
- Tipos são validados via allowlist (chaves do dict acima).
- Tamanho máximo por arquivo: **2 MB** (decodificado).

---

## 7. Variáveis de ambiente

Em [`backend/.env`](./backend/.env) (não commitado — ver [`.env.example`](./backend/.env.example)).

| Variável                    | Obrigatória | Default          | Descrição                                                |
|----------------------------|-------------|------------------|----------------------------------------------------------|
| `INFOSIMPLES_TOKEN`         | Sim         | —                | Token Infosimples (CNH, CRLV, CNPJ, CEP, ANTT, DETRAN)   |
| `OCR_COMPROVANTE_PROVIDER`  | Não         | `infosimples`    | `local` (EasyOCR) ou `infosimples`                       |
| `OCR_CARTAO_CNPJ_PROVIDER`  | Não         | `local`          | `local` (EasyOCR) ou `infosimples`                       |

Apenas 3 variáveis. Sem dependências de Google Sheets, Selenium ou drives mapeados.

---

## 8. Códigos de erro mais comuns

### Infosimples

| Code | Significado                                    | Ação                                                      |
|------|------------------------------------------------|----------------------------------------------------------|
| 200  | Sucesso (`billable: true`)                      | —                                                         |
| 401  | Token inválido                                  | Verificar `INFOSIMPLES_TOKEN` no `.env`                   |
| 603  | Token sem autorização para o serviço            | Contatar `suporte@infosimples.com.br`                     |
| 612  | Sem dados localizados                           | Documento pode estar irregular ou produto não cobre o estado |
| 701  | Imagem base64 inválida                          | Verificar `fileToBase64` no frontend                      |

### Backend interno

| HTTP | Significado                                              |
|------|----------------------------------------------------------|
| 400  | Validação Pydantic falhou (CPF/CNPJ/CEP errado, etc.)    |
| 422  | Schema inválido (faltando campo obrigatório)             |
| 502  | API externa falhou (`InfosimplesAPIError`)               |
| 503  | OCR local solicitado mas EasyOCR não instalado           |
| 504  | Timeout em consulta externa (`InfosimplesTimeout`)       |
| 500  | Genérico — checar logs do uvicorn                        |

---

## 9. Limpeza e TTL de anexos

- **TTL automático:** 24 horas. `limpar_antigos()` é chamado no startup do FastAPI.
- **Limpeza manual:** `POST /api/anexo/limpar?id_cadastro=<id>` apaga a pasta inteira.
- **Sobrescrita:** `salvar()` sobrescreve se o tipo já existir (re-upload pelo operador).

---

## 10. Como rodar localmente

### Backend (FastAPI)

```bash
cd frontend/src/modules/cadastro-motorista/backend
cp .env.example .env
# editar .env e colar INFOSIMPLES_TOKEN

# Primeira execução
pip install -r requirements.txt
pip install -r requirements-ocr.txt   # opcional — só pra OCR local (~600 MB)

python run.py
```

Servidor sobe em `http://127.0.0.1:8765`.

Atalho Windows: duplo-clique em `iniciar.bat` (faz tudo: instala deps, libera porta, sobe).

### Frontend (React via Vite)

A página `/cadastro` é parte do app principal Cargas Lamonica. Subir o Vite normalmente:

```bash
cd frontend
npm install
npm run dev
```

Acessar `http://localhost:8080/cadastro`. O proxy do Vite repassa `/api/*` pro backend.

---

## Apêndice — Referências cruzadas

- [README do módulo](./README.md)
- [README do backend](./backend/README.md)
- [`anexo_storage.py`](./backend/backend/anexo_storage.py) — fonte única da estrutura de pastas
- [`infosimples.py`](./backend/backend/infosimples.py) — cliente HTTP Infosimples
- [`cadastroApi.ts`](./cadastroApi.ts) — cliente HTTP do frontend
- [`CadastroDocumentos.tsx`](./CadastroDocumentos.tsx) — página `/cadastro`
