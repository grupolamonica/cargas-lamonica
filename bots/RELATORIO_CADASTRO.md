# Relatório Técnico — Cadastro AngelLira / ASPX (SPX) / Unificada

> Como funciona o cadastro de motorista, proprietário e veículo nos 3 sistemas
> (AngelLira, SPX/ASPX, Unificada) — agora 100% via API/HTTPS, sem Selenium.

---

## Sumário

1. [Arquitetura geral](#1-arquitetura-geral)
2. [AngelLira (porta 8765)](#2-angellira-porta-8765)
3. [SPX / ASPX (porta 8766)](#3-spx--aspx-porta-8766)
4. [Unificada (porta 8001)](#4-unificada-porta-8001)
5. [Pipeline de cadastro end-to-end](#5-pipeline-de-cadastro-end-to-end)
6. [Diferenças entre AngelLira e SPX](#6-diferenças-entre-angellira-e-spx)
7. [Edge cases e políticas](#7-edge-cases-e-políticas)

---

## 1. Arquitetura geral

Os 3 sidecars são **processos Python independentes** rodando em `localhost`,
cada um expondo uma API REST FastAPI consumida pelo cliente (no projeto
original era o `bot_cadastro.js`, mas pode ser qualquer cliente HTTP).

```
[ Cliente HTTP qualquer ]
      │
      │ HTTP/loopback (plain)
      ▼
┌────────────────────────────────┐
│  angelira-robo  (porta 8765)   │ ──HTTPS──► api.angellira.com.br/profile/*
│  spx-robo       (porta 8766)   │ ──HTTPS──► logistics.myagencyservice.com.br/*
│  unificada-robo (porta 8001)   │ ──HTTPS──► api.angellira.com.br/profile/query
└────────────────────────────────┘
```

- **Loopback** entre cliente e sidecar: HTTP plain (sem TLS, conexão local).
- **HTTPS/TLS** apenas entre sidecar e API externa.
- Cada sidecar gerencia sua própria autenticação, sessão e retry.

---

## 2. AngelLira (porta 8765)

### 2.1 Autenticação (descoberto via reverse engineering do bundle JS)

A API publica do AngelLira não tem um único endpoint `/login`. O fluxo é em
**2 etapas**:

```
1. POST https://auth.angellira.com.br/auth
   Headers: Content-Type: application/json
   Body:    {"login": "USER", "pass": "SENHA", "lang": "pt-br"}
   Resp:    Set-Cookie sessao (cookie HTTPOnly de auth)

2. POST https://auth.angellira.com.br/auth/grant
   Headers: Content-Type: application/x-www-form-urlencoded
            Origin/Referer: auth.angellira.com.br
   Body:    company=876943&user={"userName":"","userId":-1}
   Resp:    302/303 redirect → URL final contém ?access_token=<JWT>
```

O JWT é extraído da URL final (ou do body se o portal retornou JSON).
Anexado como `Authorization: Bearer <JWT>` na `requests.Session`.

**Singleton de sessão** (`get_shared_client()`):
- 1 login por processo Python.
- Thread-safe via `threading.Lock`.
- Refresh automático em 401: `_fetch_with_retry` detecta status 401 →
  chama `login()` de novo → retenta a request original.

### 2.2 Endpoints externos usados

Base: `https://api.angellira.com.br/profile`

| Categoria | Endpoint | Função |
|-----------|----------|--------|
| **Geo**   | `GET /geo/address?cep=XX`         | CEP → cityId/stateId/neighborhoodId/placeId |
| **Geo**   | `GET /geo/states`                 | UF → stateId |
| **Geo**   | `GET /geo/states/{id}/cities?q=`  | Lookup de cidade por nome |
| **Types** | `GET /types/drivers`              | Tipos: Funcionario=25, Agregado=26, ... |
| **Types** | `GET /types/cnh`                  | Categorias CNH: A, B, AB, C, D, E |
| **Types** | `GET /types/vehicles`             | CAVALO=1, CARRETA, BITREM, ... |
| **Types** | `GET /types/bodyworks`            | Carrocerias |
| **Types** | `GET /types/brands?q=`            | Marca de veículo |
| **Types** | `GET /types/models/{brandId}?q=`  | Modelo da marca |
| **Drivers** | `GET /drivers/cpf/{cpf}`        | Busca motorista por CPF |
| **Drivers** | `POST /drivers`                 | Cria motorista (JSON) |
| **Drivers** | `PATCH /drivers/{id}`           | Atualiza motorista (JSON) |
| **Drivers** | `PUT /drivers/{id}/cnh`         | Upload imagem CNH (multipart) |
| **Drivers** | `PUT /drivers/{id}/rg`          | Upload imagem RG (multipart) |
| **Owners**  | `GET /owners/cpf/{cpf}`         | Owner PF por CPF |
| **Owners**  | `GET /owners/cnpj/{cnpj}`       | Owner PJ por CNPJ |
| **Owners**  | `POST /owners`                  | Cria owner (retorna {id, queryId}) |
| **Owners**  | `PATCH /owners/{id}`            | Atualiza owner |
| **Vehicles**| `GET /vehicles/plate/{plate}`   | Veículo por placa (placa antiga COM hífen!) |
| **Vehicles**| `POST /vehicles`                | Cria veículo (JSON) |
| **Vehicles**| `PATCH /vehicles/{id}`          | Atualiza veículo (sem campo plate) |
| **Query**   | `GET /query?qFor=cpf&q=...`     | Lista cadastros (precheck, dossiê) |

### 2.3 Fluxo de cadastro de **MOTORISTA**

```
POST /api/robo/motorista_api/iniciar
{
  "id_cadastro": "abc",
  "type_id": 25,
  "payload": {
    "motorista": {"nome", "cpf", "telefone", "rg", "rg_uf", "nascimento", "mae"},
    "cnh":       {"numero", "categoria", "validade", "primeira_cnh", "registro"},
    "endereco":  {"cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf"}
  }
}
```

Sequência interna (`flow_motorista.cadastrar_motorista`):

```
[1] Acquire async lock por CPF (evita double-dispatch)
[2] get_shared_client()  → garante sessão JWT válida
[3] precheck.verificar_motorista_via_api(cpf)  → busca em /query até 365 dias atrás
    └─► Se encontrado + status=CONFORME → retorna {ok:True, etapa:"ja_cadastrado"}
[4] drivers.find_by_cpf(client, cpf)  → busca driver existente
    ├─► Se existe   → PATCH /drivers/{id}    (atualiza)
    └─► Se não      → POST /drivers          (cria)
       Payload contém: name, cpf, phones[{phone, typeId:3}], rg, rgIssuerStateId,
       cnh, cnhCategoryId, cnhValidity, firstCNHIssue, securityCode, motherName,
       birth, cep, address, number, complement, cityId, stateId, neighborhoodId,
       placeId, cityName, stateName, neighborhoodName,
       hasCNHImage, hasRGImage, owner:True  ◄─ flag "também é proprietário"
[5] Patch agrupado: campos de data SEMPRE juntos (birth + cnhValidity + firstCNHIssue)
    └─► Backend zera os outros do grupo se você só patch um isolado.
[6] Preflight: GET /drivers/{id}/complete  → valida cadastro
[7] store_query(driver, type=DRIVER)  → cria consulta de relatório
[8] Retorna {ok, salvou, driverId, queryId, etapa, duracao_s}
```

**Descobertas importantes:**

- `POST` minimal `{prime, cpf, name}` retorna 200 com um **"ghost id" 15228568**
  (placeholder padrão do backend). Cadastro só vira real com cityId+neighborhoodId
  resolvidos pelo CEP.
- Para o endereço funcionar, precisa enviar **AMBOS** os IDs (cityId/stateId/...)
  E os nomes (cityName/stateName/neighborhoodName).
- **`multipart` PERDE campos de data silenciosamente.** Sempre usa JSON puro
  no POST/PATCH principal. Multipart só para arquivos (CNH/RG via PUT).
- **PATCH zera campos do grupo.** Os 3 campos de data têm que vir juntos.

### 2.4 Fluxo de cadastro de **PROPRIETÁRIO**

```
POST /api/robo/proprietario_api/iniciar
{
  "tipo": "PJ",  ou "PF"
  "payload": {
    "cnpj": "...",  // PJ
    "razao_social": "...",
    "telefone": "...",
    "endereco": {...}
  }
}
```

Diferenças PF vs PJ:
- **PF (`type="natural"`)**: requer CPF, `phones[].typeId=3` (celular).
- **PJ (`type="legal"`)**: requer CNPJ, razão social, `phones[].typeId=2` (fixo).

Sequência (`flow_proprietario.cadastrar_proprietario`):

```
[1] Lock por documento (CPF ou CNPJ)
[2] owners.find_by_cpf / find_by_cnpj  → busca existente
[3] Se existe   → PATCH /owners/{id}
    Se não      → POST /owners  → retorna {id, queryId} (já cria a consulta junto)
[4] Retorna {ok, ownerId, etapa, duracao_s}
```

**Não aceitos no POST /owners**: companyId, complement, cityName, stateName,
ie, stateRegistration, cellphone, objetos nested para city/state/neighborhood.

### 2.5 Fluxo de cadastro de **VEÍCULO** (cavalo / carreta)

```
POST /api/robo/veiculo_api/iniciar
{
  "sub": "cavalo",  ou "carreta"
  "owner_cpf": "...",   // OU
  "owner_cnpj": "...",  // OU
  "owner_id": 12345,    // pré-resolvido
  "payload": {
    "placa": "ABC1234",
    "renavam": "...",
    "chassi": "...",
    "marca_modelo": "VOLKSWAGEN/CONSTELLATION",
    "ano_fab": 2020, "ano_modelo": 2020, "cor": "BRANCO",
    "carroceria": "ABERTA"
  }
}
```

Sequência (`flow_veiculo.cadastrar_veiculo`):

```
[1] Resolve ownerId  ──┐
   ├─► owner_id passado direto:
   │     valida contra OWNERS_GENERICOS (bloqueia GRIFFI 876943 etc)
   ├─► owner_cnpj/owner_cpf:
   │     owners.find_by_cpf/cnpj → se NÃO acha → HTTP 422 STRICT
   └─► sem nada:
         HTTP 400 owner_nao_informado
[2] Lock por placa normalizada
[3] precheck.verificar_veiculo_via_api(placa)  → check /query
[4] vehicles.find_by_plate(client, placa_com_hifen_se_antiga)
   ├─► existe  → PATCH /vehicles/{id}  (sem campo `plate`)
   └─► novo    → POST /vehicles
       Payload: prime, typeId, plate, color, renavam, chassis, axles,
                ownerId, brandId, modelId, fabricationYear, modelYear,
                plateStateId, plateCityId, relationship,
                antt (se anttControl=true no type), bodyworkId
[5] store_query(vehicle, type=VEHICLE)
[6] Retorna {ok, vehicleId, queryId, owner_fallback:False}
```

**Descobertas:**

- **Placa antiga (AAA-9999) precisa de HÍFEN** no GET /vehicles/plate.
  Placa Mercosul (AAA0A99) não precisa.
- **PATCH não aceita `plate`** (read-only). Sempre tirar da body.
- **POLÍTICA ESTRITA (2026-05-27)**: nunca cadastra veículo sem owner real.
  Sem fallback GRIFFI. Sem ownerId genérico. Se lookup falha → 422 com causa.

### 2.6 Pré-check de owner divergente (`check_owner`)

```
POST /api/robo/veiculo_api/check_owner
{"placa": "ABC1234", "expected_cpf": "...", "expected_cnpj": "...", "expected_tipo": "PF"}
```

Caso real (motorista SAMUEL DINIZ PAIVA, 2026-05-27):
- Motorista enviou CNH no bot (interpretado como prop=PF).
- Veículo HFD4F53 já existia no AngelLira com FEDERAL TRANSPORTES LTDA (PJ).
- Sem o check_owner, o disparo cria PROP PF órfão e o veículo continua FEDERAL.

Retorna:
```json
{
  "ok": true, "veiculo_existe": true, "vehicle_id": 12345,
  "owner_atual": {"id": 99, "name": "FEDERAL...", "cnpj": "...", "tipo": "PJ"},
  "divergencia": true,
  "motivo": "Veículo já cadastrado com PJ 'FEDERAL...' (id=99). tipo divergente (atual=PJ, esperado=PF) | CNPJ atual=X | esperado=Y"
}
```

Cliente decide se mostra modal de confirmação ao operador antes de disparar.

---

## 3. SPX / ASPX (porta 8766)

### 3.1 Autenticação = cookies exportados manualmente

**SPX NÃO tem endpoint programático de login** (bundle do portal não expõe).
A auth é 100% via cookies HTTPOnly setados por SSO em
`accounts.myagencyservice.com.br`.

Procedimento:

1. Operador faz login no portal SPX no Chrome **1 vez**.
2. Instala extensão **Cookie-Editor** (Chrome Web Store).
3. Estando no portal logado, clica na extensão → **Export → JSON**.
4. Salva o JSON em `config/spx_cookies.json`.
5. O cliente Python carrega via `auth.carregar_sessao_cookies()`.

Quando os cookies expiram (~horas/dias):
- Symptom: 401 ou 302 para `accounts.myagencyservice.com.br/login`.
- Cliente lança `SessaoExpirada` → operador reexporta cookies e chama:
  `POST http://127.0.0.1:8766/spx/session/reset`.

**Auto-rotação de cookies**: SPX rotaciona `Set-Cookie` em chamadas válidas.
Após cada response < 400, snapshot da jar é comparado com anterior. Se mudou,
salva no JSON (debounced 30s). Mantém sessão viva indefinidamente enquanto o
sistema rodar.

### 3.2 Headers obrigatórios em TODO request

```
device-id:    <32 chars hex>     ← do localStorage["device-id"] no portal
app:          ssc-spx-agency
version:      <string longa>     ← do header "version" de qualquer request do portal
Origin:       https://logistics.myagencyservice.com.br
Referer:      https://logistics.myagencyservice.com.br/
Content-Type: application/json   (multipart sobrescreve dinamicamente)
```

Sem qualquer um deles, alguns endpoints retornam erro genérico ou redirect.

### 3.3 Endpoints externos usados

Base: `https://logistics.myagencyservice.com.br`

| Função | Endpoint |
|--------|----------|
| Smoke test | `GET /api/basicserver/agency/account/current_user/basic_info` |
| `is_cpf_exist` (cheap) | `POST /api/driverservice/agency/br/driver/profile/is_cpf_exist` |
| Validate básico | `POST /api/driverservice/agency/br/driver/request/validate/basic` |
| Validate detalhe | `POST .../request/validate/detail` |
| Salvar rascunho | `POST .../request/draft/save` |
| Pre-submit | `POST .../request/submit/check` |
| **Submit final** | `POST .../request/submit` |
| Listar requests | `POST .../request/list` |
| Detalhe request | `POST .../request/detail` |
| Sacar request | `POST .../request/withdraw` |
| Sensitive (mascarados) | `POST .../request/sensitive/get` |
| Upload CNH | `POST .../request/upload/image` (ou `/upload/license`) |
| Upload RG | `POST .../request/upload/rg_photo` |
| Upload selfie | `POST .../driver/driver_photo/upload` |
| CRLV + OCR | `POST .../request/vehicle_doc/recognition` |
| Vehicle types | `GET /api/fleet_management/agency/type/search` |
| Stations | `POST /api/driverservice/agency/br/function_station_list` |
| Cidades | `GET /api/networkroute/agency/address_management/search_cities` |

### 3.4 Fluxo de cadastro de motorista (`flow_motorista`)

```
POST /spx/motorista
{
  "cpf", "driver_name", "contact_number", "gender", "birth_day",
  "city_name", "neighbourhood_name", "street_name", "address_number", "zip_code",
  "contract_type", "function_type_list", "linehaul_station_name",
  "license_number", "license_type", "license_expire_date", "cnh_remarks",
  "vehicle_type_name", "license_plate", "vehicle_manufacturer", "vehicle_manufacturing_year",
  "vehicle_owner_name", "renavam",
  "cnh_frente_path", "cnh_verso_path", "selfie_path", "crlv_path", "risk_doc_path",
  "dry_run": false, "do_draft_save": false
}
```

Sequência completa:

```
[1] is_cpf_exist (cheap, sem efeito colateral)
[2] validate/basic    {cpf, driver_name, contact_number}
    ├─► retcode 271605028 (REQUEST_IN_PROGRESS) → retorna "request_pendente"
    │   com existing_request_id → cliente decide se vai /atualizar
    ├─► retcode 271627140 (DRIVER_REPEAT) → driver já existe + ativo
    ├─► is_matched=true + sem request nossa → "outra agência" → cliente decide
    │   se usa /importar_matched
    └─► continua para [3]
[3] validate/detail   {tudo + license_*  + vehicle_*}
    └─► confere CNH expiry, license_type, etc
[4] Lookups paralelos:
    ├─► search_cities(city_name) → cityId
    ├─► function_station_list   → stationId
    └─► /agency/type/search     → vehicleTypeId
[5] Uploads paralelos (multipart):
    ├─► CNH frente + verso  → /upload/image
    ├─► selfie              → /driver_photo/upload
    ├─► CRLV + OCR          → /vehicle_doc/recognition (retorna placa OCR + match)
    └─► Risk Doc PDF (opcional) → /upload/image
[6] draft/save  (opcional, do_draft_save=true)
[7] submit/check  → validação final pré-submit
[8] submit       → cria a driver_request definitiva
[9] Retorna {ok, etapa:"completo", request_id, driver_id}
```

### 3.5 Cenários especiais

**a) Driver "em outra agência" (`/spx/motorista/lookup` e `/diagnostico`):**

`validate/basic` retorna `is_matched=true` mas a request listada não é da
nossa agência. Cliente decide:
- `/spx/motorista/importar_matched` → cria request NOSSA reusando o
  driver_profile existente (CNH, foto, RG, endereço são **locked_fields**).
- Só Risk Doc + linehaul + vehicle podem ser nossos.

**b) Driver inativo (`/spx/motorista/ativar`):**

`retcode 271605004` indica driver desativado. Ativa via
`POST /api/driverservice/agency/br/driver/profile/activate`.

**c) Editar request existente (`/spx/motorista/atualizar`):**

⚠️ **DANGEROUS** (`force_overwrite=True` obrigatório). SPX **NÃO permite reverter**
alterações. Endpoint:
- Pega `request/detail/view_only=false` (desbloqueia sensitive).
- Junta `locked_fields[]` do backend com defaults locais → ignora tentativas
  de mudar campos travados.
- Re-uploada fotos novas se passadas.
- Re-submete.

**d) Complementar campos vazios (`/spx/motorista/complementar` / `/completar_outra_agencia`):**

Preenche **APENAS** campos vazios. NUNCA sobrescreve. Operação segura.
`dry_run=True` por default para revisar plano antes.

### 3.6 Locked fields (não-editáveis em requests existentes)

```
cpf, license_type, driver_name, license_number,
license_img_front, license_img_back,
license_expire_date, birth_day
```

### 3.7 Sensitive fields (mascarados em respostas)

Mascarados em `list`/`detail/view_only=true`. Precisa chamar
`request/sensitive/get` para ver real:

```
cpf, contact_number, license_number, driver_name, driver_email,
driver_photo, license_img_front/back, rg_photo_url_list,
card_number, account_name, account_number, bank_name,
image, base_photo_url, license_photo_url, risk_assessment_document
```

### 3.8 Retcodes conhecidos

| retcode | Significado |
|---------|-------------|
| 0 | Sucesso |
| 271605007 | CPF inválido |
| 271605009 | Telefone inválido (PHONE_INVALID) |
| 271605028 | Já existe solicitação aberta (REQUEST_IN_PROGRESS) — use /atualizar |
| 271627140 | CPF já cadastrado (DRIVER_REPEAT) |
| 271617003 | Motorista bloqueado (DRIVER_BLOCKED) |
| 271605004 | Driver inativo — use /ativar |
| 991900001 | OCR não extraiu CRLV |
| 991900013/14/16/18 | Erros de upload (backend / tipo / tamanho / formato) |

---

## 4. Unificada (porta 8001)

### 4.1 O que faz

Gera o **Risk Assessment Document (PDF unificado)** consolidando motorista
(CPF) + cavalo (placa) + carreta (placa) num único PDF, **a partir da API**.

Versão Selenium antiga: ~60-90s (login Chrome + abrir /relatorio + printToPDF).
Versão API atual: **~3-5s**.

### 4.2 Autenticação

Reusa o mesmo fluxo do AngelLira (`POST /auth` + `/auth/grant` → JWT).
Token em cache em memória com TTL de **20 minutos**, refresh automático em 401.

### 4.3 Fluxo de geração de PDF (`gerar_pdf_unificado`)

```
POST /relatorio/pdf_unificado
{"cpf": "...", "placa_cavalo": "...", "placa_carreta": "..."}
```

```
[1] get_cached_token()  → aquece JWT antes das 3 queries paralelas
[2] ThreadPoolExecutor(max_workers=3):
    ├─► query_profile_records(cpf, "cpf")           → motorista
    ├─► query_profile_records(placa_cavalo, "plate") → cavalo
    └─► query_profile_records(placa_carreta, "plate") → carreta
[3] Para cada componente encontrado:
    └─► Monta sections via ReportLab platypus:
        ├─► _build_motorista_section(rec)
        ├─► _build_veiculo_section(rec, 'Cavalo', is_carreta=False)
        └─► _build_veiculo_section(rec, 'Carreta', is_carreta=True)
[4] SimpleDocTemplate.build(elements + page_break entre componentes)
[5] Retorna {ok, output_path, components: {motorista:{found,status,id,limit_date}, ...}, warnings}
```

### 4.4 Layout do PDF

Fiel ao portal AngelLira:
- "Detalhes da Consulta" → preto bold 14pt
- "Consulta", "Dados do Motorista", "Dados do Veículo" → azul ciano (#01b6ed) bold 10pt
- Labels → cinza 8pt
- Valores → preto 10pt
- Status badges: verde (#16a34a) para Conforme, vermelho (#dc2626) para Não Conforme
- Logo AngelLira SVG opcional (header) via `svglib`

### 4.5 Endpoint /relatorio/consultar

Read-only — retorna o primeiro registro da query:

```
POST /relatorio/consultar
{"query_value": "12345678909", "q_for": "cpf"}

Resposta:
{
  "ok": true, "encontrado": true, "total": 5,
  "registro": {
    "id": ..., "status": {"description": "Conforme"}, "limitDate": "2026-12-31",
    "driver": {...}, "vehicle": {...}, ...
  }
}
```

---

## 5. Pipeline de cadastro end-to-end

No sistema original (com `bot_cadastro.js`), o cadastro completo de um
motorista + cavalo + carreta + proprietário (caso típico) seguia esta ordem:

```
[A] WhatsApp bot coleta documentos do motorista (CNH, CRLVs, comprovantes)
    │
[B] Operador valida OCR no painel (painel_cadastro.html, porta 5010)
    │
[C] Operador clica "Disparar TUDO" (ou botões individuais):
    │
    ├──[1]── POST 8765/api/robo/proprietario_api/iniciar
    │           tipo: PJ (do CNPJ do CRLV)
    │           → cria owner PJ → retorna ownerId
    │
    ├──[2]── POST 8765/api/robo/veiculo_api/iniciar  (cavalo)
    │           owner_cnpj: CNPJ_do_passo_1
    │           sub: cavalo
    │           → resolve ownerId → cria veículo → retorna vehicleId
    │
    ├──[3]── POST 8765/api/robo/veiculo_api/iniciar  (carreta)
    │           owner_cnpj: CNPJ_do_passo_1
    │           sub: carreta
    │           → cria veículo carreta
    │
    ├──[4]── POST 8765/api/robo/motorista_api/iniciar
    │           type_id: 25 (Funcionário) ou 26 (Agregado)
    │           → cria driver + payload com owner:True (vira proprietário PF tb)
    │
    ├──[5]── POST 8001/relatorio/pdf_unificado
    │           cpf, placa_cavalo, placa_carreta
    │           → gera Risk Assessment Document
    │
    └──[6]── POST 8766/spx/motorista
                Cadastra a request no portal Shopee Express (SPX)
                → cria driver_request com upload de CNH/selfie/CRLV/Risk Doc
```

Cada passo é **idempotente** quando o registro já existe (PATCH em vez de POST).

---

## 6. Diferenças entre AngelLira e SPX

| Aspecto | AngelLira | SPX |
|---------|-----------|-----|
| Auth | `POST /auth` + `/auth/grant` → JWT Bearer | Cookies HTTPOnly exportados do Chrome |
| Refresh | Re-login automático em 401 | Auto-rotação via Set-Cookie persistido |
| Quando "morre" | Nunca (auto) | Quando cookies expiram (horas/dias) — reexportar |
| Selenium na origem? | Tinha (legado) — agora 0% | Sempre foi API-only |
| Paralelismo | Lock por documento (CPF/CNPJ/placa) | Singleton serializa |
| Política de owner | Estrita (sem fallback) | N/A (SPX só cadastra motorista) |
| Schema | Inferido do bundle JS público | Inferido do bundle JS (source map exposto) |
| Erros | HTTP status + detail | Envelope `{retcode, message, data}` |

---

## 7. Edge cases e políticas

### 7.1 Locks por documento (AngelLira)

Double-dispatch concorrente para o mesmo CPF/CNPJ/placa serializa via
`asyncio.Lock`. Sem isso, 2 cliques rápidos do operador batem ambos no
`find_by_cpf`, ambos voltam `None`, ambos fazem `POST` → duplicação ou erro
confuso. Implementado em `main.py:_doc_lock()`.

### 7.2 Política estrita de owner para veículo

**Antes (até 2026-05-26)**: se `owner_cnpj` não fosse encontrado, caía no
fallback GRIFFI (876943). Resultado: veículos órfãos vinculados a
"TRANSPORTADOR_N0" no AngelLira.

**Depois (2026-05-27 em diante)**: NUNCA cadastra veículo sem owner real
cadastrado. Lookup falha → HTTP 422 com `causa="proprietario_nao_existe_no_angellira"`.
Operador resolve o owner antes.

Lista de `OWNERS_GENERICOS` (definida em `flow_veiculo.py`) é bloqueada
explicitamente mesmo se passada via `owner_id` direto.

### 7.3 Multipart vs JSON no AngelLira

**Multipart perde campos de data silenciosamente** (birth, cnhValidity,
firstCNHIssue). Bug do backend AngelLira. Sempre usa JSON no POST/PATCH
principal. Multipart só para uploads de imagem via PUT `/cnh` e `/rg`.

### 7.4 PATCH zera campos do grupo

Backend AngelLira tem grupos de campos que são reset quando você toca em
um isolado:
- **CAMPOS_DATA** (`birth`, `cnhValidity`, `firstCNHIssue`): sempre patch juntos
- **CAMPOS_ENDERECO**: API rejeita `address`, `cityId`, `stateId`, `neighborhoodId`,
  `placeId`, `cityName`, `stateName`, `neighborhoodName` no PATCH/POST de
  driver existente. `number` e `complement` são aceitos.

Usar `patch_grouped()` em `drivers.py` para automatizar.

### 7.5 "Ghost ID" no AngelLira

POST `/drivers` minimal `{prime, cpf, name}` retorna **200 OK** com `id=15228568`
(placeholder padrão do backend). Só vira cadastro real quando payload inclui
cityId + neighborhoodId + placeId resolvidos por CEP.

### 7.6 Placa antiga vs Mercosul (AngelLira)

```
Placa antiga (AAA9999):    GET /vehicles/plate/AAA-9999     ← HÍFEN obrigatório
Placa Mercosul (AAA0A99):  GET /vehicles/plate/AAA0A99      ← sem hífen
```

POST com placa antiga sem hífen → erro "placa valida no mercosul pattern".

### 7.7 SPX: cookies expiram, schema pode mudar

- Cookies expiram a cada poucos dias — operador reexporta.
- Schema do payload é derivado do bundle JS público (source map exposto).
  Pequenas mudanças do portal podem quebrar uma chamada. Versionar com
  cuidado e monitorar logs de 4xx/5xx.

### 7.8 SPX: OCR do CRLV pode errar

`vehicle_doc/recognition` retorna `ocr_result`:
- `0` → OCR ok, dados extraídos
- `!= 0` → falha — operador preenche manualmente os campos vehicle_* no payload.

---

## Apêndice: estrutura de arquivos

```
bots/
├── README.md                  ← este guia geral
├── RELATORIO_CADASTRO.md      ← este relatório técnico
├── angelira/                  ← sidecar AngelLira (porta 8765)
│   ├── run.py
│   ├── .env.example
│   ├── README.md
│   ├── requirements.txt
│   └── backend/
│       ├── main.py
│       ├── config.py
│       ├── anexo_storage.py
│       └── angelira_robo/
│           ├── auth.py
│           ├── helpers.py
│           ├── logger.py
│           ├── precheck_types.py
│           └── api_query/
│               ├── client.py
│               ├── drivers.py
│               ├── owners.py
│               ├── vehicles.py
│               ├── geo.py
│               ├── queries.py
│               ├── mapping.py
│               ├── precheck.py
│               ├── flow_motorista.py
│               ├── flow_proprietario.py
│               └── flow_veiculo.py
├── spx/                       ← sidecar SPX (porta 8766)
│   ├── run.py
│   ├── .env.example
│   ├── README.md
│   ├── requirements.txt
│   ├── config/
│   │   └── spx_cookies.json   ← exportar do Chrome
│   ├── examples/
│   │   └── cadastrar_motorista.py
│   └── backend/
│       ├── main.py
│       └── spx_robo/
│           ├── auth.py
│           ├── client.py
│           ├── constants.py
│           ├── drivers.py
│           ├── flow_motorista.py
│           ├── lookups.py
│           ├── uploads.py
│           └── logger.py
└── unificada/                 ← sidecar Unificada (porta 8001)
    ├── run.py
    ├── .env.example
    ├── README.md
    ├── requirements.txt
    ├── static/
    │   └── img/angellira-logo.svg
    └── backend/
        ├── main.py
        └── unificada_robo/
            ├── auth.py
            ├── helpers.py
            ├── logger.py
            ├── relatorio_api.py
            └── relatorio_api_pdf.py
```
