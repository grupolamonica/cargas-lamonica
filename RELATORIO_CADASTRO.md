# Relatório Técnico — Tela de Cadastro de Motorista PJ

**Projeto:** Lamonica Cargas (LMC)
**Rota:** `/cadastro` (pública)
**Commit principal:** `ef79d72 — feat: add public driver PJ document registration page`
**Data do relatório:** 2026-04-30
**Volume entregue:** 6.741 linhas adicionadas, 1 removida

---

## 1. Sumário Executivo

A tela `/cadastro` é uma página pública de pré-cadastro de motorista PJ, otimizada para preenchimento assistido por OCR. Substitui o preenchimento manual por upload de documentos: o sistema lê CNH/CRLV/comprovante/cartão CNPJ, extrai os campos automaticamente e ainda dispara consultas em cadeia (Receita Federal via Infosimples, ANTT, CEP) para validar tudo antes do envio.

**Status atual:**
- ✅ Frontend completo (5 abas, validação, OCR, consultas, UI)
- ✅ Endpoint backend de pré-registro implementado (`POST /api/loads/:loadId/pre-registration`)
- ✅ Schema Postgres + RLS + auditoria + rate limit + PII redaction
- ⚠️ **Submissão final do formulário ainda é placeholder** (toast de sucesso após 600ms, sem POST real). O endpoint de salvamento end-to-end do cadastro completo (todos os documentos + dados bancários + proprietário) ainda não existe.
- ⚠️ Storage de arquivos físicos (PDF/JPG) ainda não conectado (Supabase Storage não cabeado).

---

## 2. Arquitetura

```
┌────────────────────────────────────────────────────────────┐
│  Browser (/cadastro)                                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  CadastroDocumentos.tsx (4561 linhas)                │  │
│  │  ├─ 5 Tabs: Motorista → Cavalo → Carreta            │  │
│  │  │           → Operacional → Proprietário            │  │
│  │  ├─ Handlers OCR (CNH, CRLV, Comprov., CartãoCNPJ)  │  │
│  │  ├─ Validação ANTT em cascata                       │  │
│  │  └─ Validators (cpf/cnpj/placa/cep/chassi/renavam)  │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                  │
│                          ▼ via cadastroApi.ts              │
│              POST /ocr-api/api/...                          │
└────────────────────────────────────────────────────────────┘
                           │
                           │ (proxy Vite dev: /ocr-api/* → :8765)
                           ▼
┌────────────────────────────────────────────────────────────┐
│  FastAPI Python (porta 8765 — wrapper local)               │
│  ├─ /api/ocr/cnh              → Infosimples (~R$ 0,30)     │
│  ├─ /api/ocr/crlv             → Infosimples (~R$ 0,30)     │
│  ├─ /api/ocr/comprovante      → EasyOCR local (offline)    │
│  ├─ /api/ocr/cartao-cnpj      → EasyOCR local (offline)    │
│  ├─ /api/consulta/cnpj        → Infosimples RF (~R$ 0,15)  │
│  ├─ /api/consulta/antt        → Infosimples (~R$ 0,30)     │
│  ├─ /api/consulta/antt-veiculo→ Infosimples (cascata)     │
│  └─ /api/consulta/cep         → Infosimples + fallback    │
└────────────────────────────────────────────────────────────┘
                           │
                           ▼ (separado, fluxo de pré-registro de lead)
┌────────────────────────────────────────────────────────────┐
│  Backend Node.js (Cargas_Lamonica/backend/)                │
│  POST /api/loads/:loadId/pre-registration                  │
│  ├─ Zod validate (cpf, phone, plates, vehicleType)         │
│  ├─ Rate limit por IP (5/hora)                             │
│  ├─ INSERT em load_public_leads (status=PRE_REGISTERED)    │
│  ├─ INSERT em load_public_lead_events (auditoria)          │
│  └─ Fire-and-forget: validação Angellira (CPF) + ASPX     │
└────────────────────────────────────────────────────────────┘
```

---

## 3. Frontend

### 3.1 Arquivos criados

| Arquivo | Linhas | Função |
|---|---|---|
| [frontend/src/pages/CadastroDocumentos.tsx](frontend/src/pages/CadastroDocumentos.tsx) | 4.561 | Página principal — 5 abas + handlers + UI |
| [frontend/src/lib/cadastroApi.ts](frontend/src/lib/cadastroApi.ts) | ~1.200 | Cliente HTTP — OCR + consultas + compressão |
| [frontend/src/lib/cadastroApi.test.ts](frontend/src/lib/cadastroApi.test.ts) | 149 | Testes do cliente |
| [frontend/src/lib/validators.ts](frontend/src/lib/validators.ts) | 158 | CPF/CNPJ/placa/CEP/chassi/renavam/PIS/CNH/telefone |
| [frontend/src/lib/dateDisplay.ts](frontend/src/lib/dateDisplay.ts) | +23 | `normalizeDateInputValue()` |
| [frontend/src/App.tsx](frontend/src/App.tsx) | +3 | Lazy import + rota `/cadastro` |
| [frontend/vite.config.ts](frontend/vite.config.ts) | +5 | Proxy dev `/ocr-api/* → :8765` |

### 3.2 Estrutura do formulário (FormData)

```typescript
type FormData = {
  id_cadastro: string;
  tipo_composicao: "sem_carreta" | "1_carreta" | "bitrem";
  carreta_proprietario_diferente: boolean;
  arquivos: Arquivos;                       // 12 slots de upload
  motorista: Motorista;                     // dados pessoais + telefones
  cnh: CNHData;                             // 7 campos da CNH
  endereco_motorista: Endereco;             // CEP + endereço completo
  cavalo: Veiculo;                          // 15 campos do trator
  carreta: Veiculo;                         // condicional
  carretas_extras: CarretaExtra[];          // suporte a bitrem
  proprietario_pj: ProprietarioPJ;          // razão social + CNPJ + bancos
  proprietario_pf: ProprietarioPF;          // CPF + CNH + PIS + bancos
  proprietario_pj_carreta, proprietario_pf_carreta;  // se carreta de outro dono
  cnh_proprietario_pf, cnh_proprietario_pf_carreta;
  operacional: Operacional;                 // tag de pedágio + rastreador
  proprietario_antt_cavalo, proprietario_antt_carreta;
};
```

### 3.3 As 5 abas (com unlock progressivo)

| # | Tab | Campos chave | Arquivos exigidos | Critério de "completa" |
|---|---|---|---|---|
| 1 | **Motorista** | nome, CPF, RG, data_nascimento, pai/mãe, CNH (registro/categoria/UF/validade), telefones, endereço completo | `cnh`, `comprovante_motorista` | todos campos + ≥1 telefone + 2 arquivos |
| 2 | **Cavalo (Trator)** | placa, tipo, marca, modelo, ano fab/mod, cor, renavam, chassi, eixos, ANTT | `crlv_cavalo` | veículo completo + CRLV |
| 3 | **Carreta** | idem cavalo (condicional ao `tipo_composicao`) | `crlv_carreta` | depende de `tipo_composicao` |
| 4 | **Operacional** | tag de pedágio (SEM_PARAR / CONECTCAR / MOVE_MAIS / VELOE / ENDERED / NAO_POSSUI), possui pancary, rastreador (marca/número/arquivo) | (opcional) | sempre desbloqueada |
| 5 | **Proprietário** | **PJ:** razão social, CNPJ, IE, dados bancários, endereço. **PF:** CPF, RG, estado civil, cor/raça, PIS, dados bancários, endereço, CNH (se `tem_cnh=true`) | `cartao_cnpj` ou `cnh_proprietario` etc. | lógica combinatorial: motorista é proprietário OU prop validado + uploads |

### 3.4 Componentes inline reutilizáveis

- **`CnpjLookupField`** ([:1165](frontend/src/pages/CadastroDocumentos.tsx#L1165)) — input CNPJ formatado + botão "Buscar" que chama `consultaCnpj`
- **`DadosBancariosFields`** ([:1215](frontend/src/pages/CadastroDocumentos.tsx#L1215)) — Banco (dropdown) + Agência + Conta + Tipo
- **`ProprietarioPJFields`** ([:1279](frontend/src/pages/CadastroDocumentos.tsx#L1279)) — bloco completo de PJ com CNPJ lookup
- **`ProprietarioPFFields`** ([~:1354](frontend/src/pages/CadastroDocumentos.tsx#L1354)) — bloco PF com CNH condicional

---

## 4. Cliente HTTP (`cadastroApi.ts`)

### 4.1 Configuração base

```typescript
const BASE = "/ocr-api";                     // proxy dev → http://localhost:8765
const MAX_BASE64_BYTES = 1_400_000;          // 1.4 MB por imagem
const MAX_IMG_DIMENSION = 1200;              // pixels máximos por lado
```

### 4.2 Compressão de imagens client-side

A função `compressImage(file)` ([:51-105](frontend/src/lib/cadastroApi.ts#L51)) faz:
1. Carrega imagem em canvas
2. Reduz dimensão para ≤1200px no maior lado
3. Exporta JPEG com `quality=0.4` progressivo
4. Se ainda excede 1.4 MB, reduz dimensão à metade e tenta de novo
5. Garante que o base64 cabe no limite antes de enviar

### 4.3 Função HTTP base

```typescript
async function postJson<T>(path, body): Promise<T> {
  // 1. fetch JSON com Content-Type: application/json
  // 2. Erro de rede → "Não foi possível alcançar a API local"
  // 3. Status ≠ 2xx → extrai detail e lança Error
  // 4. JSON inválido → "Resposta inválida"
}
```

---

## 5. APIs Externas — Como Cada Uma é Usada

### 5.1 Infosimples — OCR de Documentos

**Provedor:** Infosimples Receita Federal e OCR
**Auth:** `INFOSIMPLES_TOKEN` (env, lida no FastAPI Python)
**Envelope de resposta:** `{ code: 200, code_message?, data: [{...}] }`

#### 5.1.1 OCR de CNH — `POST /api/ocr/cnh`

```json
Request:  { "imagem": "data:image/jpeg;base64,..." }
Response: { code: 200, data: [{ pessoal: {...}, cnh: {...} }] }
```

**Uso na UI:** `handleCnhMotoristaFile` ([:2792](frontend/src/pages/CadastroDocumentos.tsx#L2792)) e `handleCnhProprietarioFile` ([:3243](frontend/src/pages/CadastroDocumentos.tsx#L3243))

**Campos extraídos:** `nome`, `cpf`, `data_nascimento`, `nome_pai`, `nome_mae`, `naturalidade`, `rg`, `rg_orgao`, `rg_uf`, `registro` (CNH), `categoria`, `codigo_seguranca`, `numero_espelho`, `uf_emissor`, `validade`, `primeira_emissao`

**Parsers auxiliares:**
- `splitFiliacao()` — separa pai/mãe quando vem em string única
- `splitRG()` — separa RG/órgão/UF
- `splitLocal()` — separa cidade/UF da naturalidade

**Custo estimado:** R$ 0,30 por OCR

#### 5.1.2 OCR de CRLV — `POST /api/ocr/crlv`

```json
Request:  { "imagem": "..." }
Response: { code: 200, data: [{ veiculo: {...}, proprietario: {documento, tipo, nome} }] }
```

**Uso na UI:** `handleCrlvFile(file, target)` ([:3071-3216](frontend/src/pages/CadastroDocumentos.tsx#L3071)) — onde `target` é `"cavalo"` ou `"carreta"`

**Comportamento especial:**
1. Salva snapshot original (`crlvSnapshot`) com placa/chassi/renavam pra cross-check visual de edições futuras
2. Auto-detecta tipo do proprietário: 14 dígitos → PJ, 11 dígitos → PF
3. **Se CNPJ:** dispara automaticamente `consultaCnpj()` em cascata e preenche bloco PJ + card de status verde/vermelho
4. **Se CPF:** apenas preenche cpf+nome no bloco PF (aguarda CNH separada pro resto)
5. **Auto-valida ANTT:** chama `validateAntt(target, hint)` com `{rntrc, cnpj, cpf, placa}` extraídos

**Campos veículo:** `placa`, `tipo`, `carroceria`, `marca`, `modelo`, `ano_fabricacao`, `ano_modelo`, `cor`, `uf_emplacamento`, `cidade_emplacamento`, `renavam`, `chassi`, `eixos`, `antt`, `ultimo_licenciamento`

**Custo estimado:** R$ 0,30 por OCR

#### 5.1.3 Consulta CNPJ — `POST /api/consulta/cnpj`

```json
Request:  { "cnpj": "12345678000199" }
Response: { code: 200, data: [{
  razao_social, nome_fantasia, cnpj, situacao_cadastral,
  cep, uf, cidade, bairro, logradouro, numero,
  ddd_telefone_1..3, telefone_1..3, email,
  capital_social, porte, natureza_juridica, atividade_economica
}] }
```

**Uso na UI:** botão "Buscar" no `CnpjLookupField` + automático após OCR de CRLV/Cartão CNPJ

**Função:** `consultaCnpj(cnpj)` ([cadastroApi.ts](frontend/src/lib/cadastroApi.ts))

**Pós-processamento:**
- `extractPhones()` combina `ddd_telefone_*` + `telefone_*` → normaliza para `(11) 9xxxx-xxxx`
- Flag `ok = /^ATIV/.test(situacao)` (status "ATIVA" ⇒ válida)
- Status ≠ 200 → `Error(code_message)`

**Custo estimado:** R$ 0,15 por consulta

#### 5.1.4 Consulta ANTT (RNTRC) — `POST /api/consulta/antt`

**Cascata de fallback** ([cadastroApi.ts:601-639](frontend/src/lib/cadastroApi.ts#L601)):

```
1. Se rntrc existe         → POST /api/consulta/antt        { rntrc }
2. Senão se cnpj.length=14 → POST /api/consulta/antt        { cnpj }
3. Senão se cpf.length=11  → POST /api/consulta/antt        { cpf }
4. Senão se placa.length=7 → POST /api/consulta/antt-veiculo { placa, cpf?, cnpj? }
5. Senão                   → throw Error("informe rntrc, cnpj, cpf ou placa")
```

**Uso:** `validateAntt(target, hint?)` ([:2998-3062](frontend/src/pages/CadastroDocumentos.tsx#L2998)) é chamado **automaticamente** após OCR de CRLV (com hint do OCR) e **manualmente** via botão "Validar ANTT"

**Resposta extraída:** `situacao`, `vencimento`, `transportador`, `cnpj_transportador`, `tipo_transportador`, `rntrc`

**Flags:**
- `ok = /\b(regular|ativ|valid)\w*/i.test(situacao)`
- `found = Boolean(rntrc || situacao || transportador)`

**UI:** card colorido (verde se ok, vermelho se irregular) + toast

**Custo estimado:** R$ 0,30 por consulta

#### 5.1.5 Consulta Veículo (Detran/Senatran) — `POST /api/consulta/antt-veiculo`

**Cascata no backend Python:** detran-{uf}/restricoes-veiculo → denatran → senatran/sinesp-cidadao

```json
Request:  { "placa": "ABC1234", "renavam": "12345678901", "uf": "SP" }
Response: { placa, marca_modelo, ano_modelo, cor, municipio, uf,
            situacao, licenciamento_situacao, licenciamento_ano,
            licenciamento_validade, ipva_situacao,
            debitos_total, multas_qtd, restricoes, produto_usado }
```

**Flag `ok`:**
```
situacao NÃO contém ROUB|FURT|APREEN|BLOQ|RESTRIC
E
licenciamento NÃO contém IRREGULAR|VENCID|ATRAS|PEND
```

### 5.2 EasyOCR (local, offline) — Documentos sem custo

**Implementação:** modelo Python no FastAPI :8765, sem chamada externa.

#### 5.2.1 Comprovante de Residência — `POST /api/ocr/comprovante-residencia`

```json
Request:  { "imagem": "...", "concessionaria": "neoenergia" }
Response: { code: 200, data: [{ cep, uf, cidade, bairro, logradouro, numero }] }
```

**Uso na UI:** `handleComprovanteMotoristaFile` ([:2830-2878](frontend/src/pages/CadastroDocumentos.tsx#L2830))

**Comportamento especial — auto-consulta CEP:**
1. Se OCR retorna CEP com 8 dígitos
2. Dispara `consultaCep()` para enriquecer endereço
3. **Cascata de prioridade:** ViaCEP/Infosimples > OCR > valor atual no form
4. Preenche `endereco_motorista` final com merge

#### 5.2.2 Cartão CNPJ — `POST /api/ocr/cartao-cnpj`

```json
Request:  { "imagem": "..." }
Response: { code: 200, data: [{ cnpj, razao_social, nome_fantasia,
                                 cep, uf, cidade, bairro, logradouro, numero }] }
```

**Uso na UI:** `handleCartaoCnpjFile` ([:3219](frontend/src/pages/CadastroDocumentos.tsx#L3219)) e versão carreta ([:3278](frontend/src/pages/CadastroDocumentos.tsx#L3278))

### 5.3 Consulta de CEP — Estratégia em Cascata

**Função:** `consultaCep(cep)` ([cadastroApi.ts:850-894](frontend/src/lib/cadastroApi.ts#L850))

```
1. POST /api/consulta/cep  (Infosimples via FastAPI local)
   ↓ se falhar OU sem uf/cidade
2. GET https://viacep.com.br/ws/{cep}/json/  (público, sem auth)
   ↓ merge: Infosimples > ViaCEP > erro
3. Se ≥1 campo (uf|cidade|bairro|logradouro) → sucesso
   Senão → Error
```

**ViaCEP:** API pública gratuita, sem token, sem rate limit explícito.

### 5.4 Angellira — Validação de CPF (background)

**Onde:** somente backend, em [backend/src/application/load-claims/public-lead-validation.js](backend/src/application/load-claims/public-lead-validation.js)

**Quando:** chamado de forma **deferred** (fire-and-forget) após o pré-registro do lead. Não bloqueia a resposta HTTP ao motorista.

**Resultado:** persistido em `load_public_leads.validation_summary_json` + `validation_status` + `validation_checked_at`

### 5.5 ASPX — Cross-check de Motorista PF

**Onde:** somente backend, em `backend/src/infrastructure/aspx/`

**Quando:** mesmo fluxo deferred do Angellira

**Função:** confirma se CPF existe no diretório ASPx (sistema de transporte legado integrado por CSV)

---

## 6. Endpoints Backend (Node.js)

### 6.1 `POST /api/loads/:loadId/pre-registration` — Pré-cadastro de Lead

**Arquivo:** [backend/src/interface/http/load-claims/handlers.js:393-411](backend/src/interface/http/load-claims/handlers.js#L393)

**Schema Zod ([:92-99](backend/src/interface/http/load-claims/handlers.js#L92)):**
```javascript
{
  cpf: z.string().trim().min(11),
  phone: z.string().trim().min(10),
  horsePlate: z.string().trim().min(7),
  trailerPlate: z.string().trim().max(7).optional().default(""),
  trailerPlate2: z.string().trim().max(7).optional().default(""),
  vehicleType: canonicalVehicleProfileSchema   // CARRETA | CAVALO_SIMPLES | BITREM
}
```

**Fluxo do handler:**
1. `getCorrelationId(request)` — lê `X-Correlation-Id` ou cria nova
2. `parseJsonBody` + `schema.parse()`
3. `getRequestIp(request)` — IP do cliente
4. `createPublicLoadLeadPreRegistration({loadId, payload, correlationId, requestContext: {clientIp}})`
5. Status 201 (novo) ou 200 (reusado)

**Lógica em `createPublicLoadLeadPreRegistration`** ([backend/src/application/load-claims/public-leads.js:1046-1261](backend/src/application/load-claims/public-leads.js#L1046)):

1. **Normalização** — `normalizeCpf()`, `normalizePhone()`, `normalizePlate()`, validação trailer plates por `vehicleType`
2. **Transação Postgres** com `withPgTransaction`
3. **Valida load** — existe? status=OPEN? perfil bate com vehicleType?
4. **Rate limit** por IP — `DEFAULT_PUBLIC_LEAD_PRE_REGISTRATION_MAX_ATTEMPTS = 6` em 600s
5. **Busca/insere lead** via unique index `ux_load_public_leads_active_identity` (load_id + cpf + phone + plates) — se existe e status≠APPROVED, reutiliza (`reused=true`)
6. **Eventos auditoria** — `insertPublicLeadEvent` com tipo `PRE_REGISTERED` e `QUEUED`
7. **Transição imediata** → status=`QUEUED` (sem aguardar)
8. **Validação detachada** após commit — `runDeferredPublicLeadValidation` (Angellira + ASPX em background)
9. **Resposta** com CPF/phone mascarados (`***.***.***-**`)

### 6.2 Rate Limiting

```javascript
// handlers.js:38-62
const REGISTRATION_RATE_LIMIT = 5;                       // por janela
const REGISTRATION_RATE_WINDOW_MS = 60 * 60 * 1000;     // 1 hora
const registrationRateLimitByIp = new Map();             // estado em memória
```

⚠️ **Observação H-01 do CLAUDE.md:** rate limit em memória quebra em serverless. O refactor para container Docker resolve.

### 6.3 Resposta padrão

```json
201 Created (lead novo) | 200 OK (reusado):
{
  "ok": true,
  "lead": {
    "id": "uuid",
    "status": "QUEUED",
    "cpf": "***.***.***-**",
    "phone": "(**) 9****-****",
    "horsePlate": "ABC1234",
    "trailerPlate": "...",
    "trailerPlate2": "",
    "vehicleType": "CARRETA",
    "preRegisteredAt": "...",
    "queuedAt": "...",
    "validation": { "status": "PENDING", ... },
    "queuePosition": 3
  },
  "load": { "id": "...", "status": "OPEN", "perfil": "..." },
  "meta": { "correlationId": "...", "reused": false, "validationPending": true }
}
```

---

## 7. Schema do Banco de Dados

**Arquivo:** [supabase/bootstrap.sql](supabase/bootstrap.sql)

### 7.1 `public.load_public_leads` (linhas 732-756)

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | gen_random_uuid() |
| `load_id` | uuid FK | → cargas(id) ON DELETE CASCADE |
| `cpf`, `phone` | text NOT NULL | armazenados em claro até PII redaction |
| `horse_plate`, `trailer_plate`, `trailer_plate_2` | text NOT NULL | placas |
| `vehicle_type` | text NOT NULL | CARRETA / CAVALO_SIMPLES / BITREM |
| `status` | text | CHECK: PRE_REGISTERED / QUEUED / APPROVED / CANCELLED |
| `pre_registered_at`, `queued_at`, `whatsapp_clicked_at`, `approved_at` | timestamptz | timeline |
| `approved_by` | uuid FK | → auth.users(id) |
| `pii_redacted_at` | timestamptz | quando CPF/phone foram mascarados |
| `validation_status` | text | PENDING / SUCCESS / FAILED |
| `validation_checked_at` | timestamptz | |
| `validation_summary_json` | jsonb | resultado Angellira+ASPX |

**Índices ([:820-842](supabase/bootstrap.sql#L820)):**
- `ux_load_public_leads_active_identity` — UNIQUE(load_id, cpf, phone, horse_plate, trailer_plate, trailer_plate_2) WHERE status IN (...)
- `idx_load_public_leads_load_status_queue` — fila operacional
- `idx_load_public_leads_pii_redacted_at` — GDPR (retenção 30 dias)
- `idx_load_public_leads_validation_status` — para reprocessar pendências

**RLS ([:866-877](supabase/bootstrap.sql#L866)):**
- SELECT: `current_app_role() = 'operator'`
- UPDATE: `current_operator_access_level() IN ('advanced', 'intermediate')`

### 7.2 `public.load_public_lead_events`

Auditoria — cada ação registra um evento:
- `event_type`: PRE_REGISTERED, QUEUED, WHATSAPP_CLICKED, APPROVED, CANCELLED, IP_EVENT
- `event_payload_json`: `{correlation_id, source, vehicle_type, ...}`
- `actor_type`: public-driver / operator / system
- `actor_id`: CPF / UUID / null

### 7.3 `public.driver_profiles`

Tabela de motoristas autenticados (Supabase Auth). **Não é alimentada pela tela de cadastro pública atual** — apenas pelo fluxo de aprovação operacional (operador converte lead aprovado em driver_profile).

---

## 8. Validações

### 8.1 Frontend — `validators.ts`

| Função | Regra |
|---|---|
| `validateCpf(v)` | 11 dígitos + checksum mod 11 (dígitos 10 e 11) + rejeita repetidos |
| `validateCnpj(v)` | 14 dígitos + checksum mod 11 (dígitos 12 e 13) + rejeita repetidos |
| `validatePlaca(v)` | aceita `AAA-1234`, `AA1A1234` (Mercosul), `AAAA1234` |
| `validateChassi(v)` | 17 chars alfanuméricos (sem `0`, `O`, `I`) |
| `validateRenavam(v)` | 11 dígitos + checksum mod 11 |
| `validateCep(v)` | 8 dígitos |
| `validateCnhRegistro(v)` | 11 dígitos |
| `validateTelefone(v)` | 10 ou 11 dígitos com DDD |
| `validatePis(v)` | 11 dígitos + checksum mod 11 |

**Aplicação:**
- **Tempo real:** `onChange` exibe erro abaixo do input (`<p className="text-xs ... text-destructive">`)
- **Em submit:** `collectValidationErrors()` ([:2700](frontend/src/pages/CadastroDocumentos.tsx#L2700)) roda em lote e bloqueia envio

### 8.2 Backend — Zod schemas

Mesmas regras (CPF 11+, phone 10+, placa 7), além de:
- `canonicalVehicleProfileSchema` — enum estrito CARRETA/CAVALO_SIMPLES/BITREM
- Trailer plates condicionais via `getTrailerPlateRequirement(vehicleType)` (BITREM exige 2 placas, etc.)

---

## 9. Segurança e Observabilidade

| Item | Status | Detalhe |
|---|---|---|
| **Correlation ID** | ✅ Backend | Header `X-Correlation-Id` propagado em todos os logs/eventos |
| **Idempotency Key** | ⚠️ Não no pré-registro | Apenas em `/api/load-claims` (mutações de claim). Pré-registro reusa via unique index |
| **Rate Limit** | ✅ Backend (in-memory) | 5/hora por IP. Vai pra Redis no refactor Docker |
| **RLS** | ✅ | Tabelas `load_public_leads*` só visíveis a operadores |
| **PII Redaction** | ✅ | Job `redactExpiredPublicLeadPii()` mascara CPF/phone após `PUBLIC_LEAD_PII_RETENTION_DAYS` (30 dias) |
| **Compressão imagens** | ✅ | Client-side antes de enviar — protege banda + custo OCR |
| **Validação dupla** | ✅ | Zod no frontend (cadastroApi) + Zod no backend (handlers) |
| **Sanitização prototype** | ✅ | `withParams()` adapter no backend (T-02-06) |
| **Limites de input** | ✅ | maxLength em route-info (T-02-07) |

---

## 10. O que **NÃO** foi implementado (backlog)

| Item | Impacto | Onde resolver |
|---|---|---|
| **POST /api/cadastro completo** | 🔴 Alto | Submit é placeholder (toast em 600ms). Nenhum dado da tela é persistido hoje. |
| **Upload físico de arquivos** | 🔴 Alto | Supabase Storage não cabeado. Bytes só ficam em memória do browser. |
| **Validação Angellira síncrona** | 🟡 Médio | Hoje só roda em background no fluxo de pré-registro — não na tela `/cadastro` |
| **Validação ASPx síncrona** | 🟡 Médio | Idem Angellira |
| **Dados bancários persistentes** | 🟡 Médio | Coletados no form, mas sem coluna no schema |
| **Etapa Proprietário ANTT** | 🟢 Baixo | Tipo `ProprietarioAntt` existe, UI ainda não renderizada |
| **Carretas extras (bitrem) UI** | 🟢 Baixo | Estrutura `carretas_extras[]` pronta, sem componente |
| **Circuit breaker em integrações** | 🟡 Médio | Hoje só try/catch ad-hoc. CONCERNS H-01 |
| **Cache de consultas (CEP, CNPJ)** | 🟢 Baixo | Sem cache — cada consulta é nova |

---

## 11. Histórico de Commits

```
ef79d72  feat: add public driver PJ document registration page    (commit principal)
7141286  ci: rebuild frontend with updated Supabase anon key
3b2f2f6  fix: preserve sheet_lh for RESERVED loads
81f1e35  feat: angellira stale fallback, aspx cookie renewal       (validações de fundo)
```

---

## 12. Resumo das Requisições HTTP (Cheat Sheet)

| Método | URL | Body | Provider | Custo |
|---|---|---|---|---|
| POST | `/ocr-api/api/ocr/cnh` | `{imagem}` | Infosimples | R$ 0,30 |
| POST | `/ocr-api/api/ocr/crlv` | `{imagem}` | Infosimples | R$ 0,30 |
| POST | `/ocr-api/api/ocr/comprovante-residencia` | `{imagem, concessionaria}` | EasyOCR local | grátis |
| POST | `/ocr-api/api/ocr/cartao-cnpj` | `{imagem}` | EasyOCR local | grátis |
| POST | `/ocr-api/api/consulta/cnpj` | `{cnpj}` | Infosimples RF | R$ 0,15 |
| POST | `/ocr-api/api/consulta/antt` | `{rntrc\|cnpj\|cpf}` | Infosimples | R$ 0,30 |
| POST | `/ocr-api/api/consulta/antt-veiculo` | `{placa, renavam?, uf?}` | Infosimples | R$ 0,30 |
| POST | `/ocr-api/api/consulta/cep` | `{cep}` | Infosimples + ViaCEP fallback | R$ 0,15 / grátis |
| GET | `https://viacep.com.br/ws/{cep}/json/` | — | ViaCEP público | grátis |
| POST | `/api/loads/:loadId/pre-registration` | `{cpf, phone, horsePlate, trailerPlate, trailerPlate2, vehicleType}` | Backend Node.js | — |

---

## 13. Conclusão

A entrega do commit `ef79d72` consolidou **todo o frontend de cadastro com OCR e consultas em cadeia**, mais o **endpoint backend de pré-registro de lead**. O fluxo do motorista do clique no banner até o registro de lead na fila do operador está funcional para o subset mínimo (CPF + phone + plates + vehicleType).

O que ainda falta para fechar o loop completo é (1) o endpoint de **submissão do cadastro completo** (com todos os documentos, dados bancários, proprietário, etc.) e (2) o **upload físico dos arquivos para Supabase Storage**. Esses dois itens viabilizam a aprovação completa do motorista e a transição lead → driver_profile sem coleta manual paralela.

A arquitetura está alinhada ao milestone `v1-refactor-arch-docker-vps`: o rate limit em memória será resolvido naturalmente pela migração para container persistente, e as integrações externas (Infosimples/ViaCEP/Angellira/ASPx) já estão isoladas no FastAPI Python e na infrastructure layer do backend Node, prontas pra Clean Architecture do refactor.
