# LGPD — OpenAI como Operador de Dados (Fase 2 da migração OCR)

**Documento:** registro de operador de dados pessoais (Art. 5º LGPD).
**Status:** ativo a partir de 2026-05-21 — vide branch `feat/ocr-gpt4o-vision-migration`.
**Owner:** Antonio César (antonio.magalhaes@grupolamonica.com.br).

---

## 1. Contexto

A Lamonica Cargas migra parte do pipeline de OCR do cadastro de motoristas
para a **API GPT-4o Vision (OpenAI Inc., EUA)**. A migração substitui o
EasyOCR local em alguns endpoints e adiciona fallback para Infosimples
quando ela falha. Vide [`docs/JIRA-WORKFLOW.md`](./JIRA-WORKFLOW.md) e o
Epic Jira **Phase 9 — Tech Debt & Escalabilidade** para tracking.

Esta migração transfere imagens de documentos pessoais (CNH, CRLV, cartão
CNPJ, comprovante ANTT, comprovante de residência, selfie c/ CNH) para
infraestrutura de um operador estrangeiro. Por isso, é necessário registro
formal sob a LGPD.

---

## 2. Operador identificado

| Campo | Valor |
|---|---|
| Razão social | OpenAI, L.L.C. |
| Sede | San Francisco, CA, EUA |
| Endpoint usado | `https://api.openai.com/v1/chat/completions` |
| Modelo | `gpt-4o` (configurável via `GPT4O_VISION_MODEL`) |
| DPA (Data Processing Agreement) | https://openai.com/policies/data-processing-addendum/ |
| Retenção declarada | 30 dias para abuse-monitoring; sem uso para treino quando API key é commercial (não-ChatGPT consumer) |
| Sub-processadores | Microsoft Azure (compute), Cloudflare (edge) |

---

## 3. Dados transferidos por endpoint

| Endpoint | Quando transfere | Campos extraídos |
|---|---|---|
| `/api/ocr/cnh` (fallback) | Infosimples retorna `code != 200` | nome, CPF, RG, data nascimento, filiação, registro CNH, categoria, validade |
| `/api/ocr/crlv` (fallback) | Infosimples retorna `code != 200` | placa, RENAVAM, chassi, marca/modelo, CPF/CNPJ proprietário, nome proprietário |
| `/api/ocr/cartao-cnpj` (primário) | Toda submissão de cartão CNPJ | CNPJ, razão social, endereço, situação cadastral |
| `/api/ocr/rntrc` (primário) | Toda submissão de comprovante ANTT | RNTRC, CPF/CNPJ titular, nome titular |
| `/api/ocr/comprovante-residencia` (primário) | Toda submissão de fatura | titular, CEP, endereço, concessionária |
| `/api/ocr/selfie-cnh` (único provider) | Toda submissão de selfie c/ CNH | flags de visibilidade + match_score (similaridade rosto x foto CNH) |

A imagem em si é enviada via base64 inline (`data:image/jpeg;base64,...`)
no campo `image_url` do payload `chat.completions.create`. Não é armazenada
pela OpenAI além da política de 30 dias para abuse monitoring (vide DPA).

---

## 4. Base legal e retenção

| Aspecto | Status |
|---|---|
| Base legal LGPD | Art. 7º V — execução de contrato (motorista candidata-se a frete via cadastro) |
| Finalidade | Validar identidade + extrair dados estruturados pra cadastro |
| Retenção OpenAI | 30 dias (abuse-monitoring) |
| Retenção Lamonica (sidecar) | 24h em `/app/backend/anexos_tmp/` (cleanup automático — vide `anexo_storage.limpar_antigos`) |
| Retenção Lamonica (DB) | Indeterminada (cadastro permanente) — campos estruturados extraídos do OCR ficam em `pending_driver_registrations.dados` |
| Direito de exclusão | Atendido via `DELETE /api/cadastro-v2/draft/{id}` + processo manual para registros DB |

---

## 5. Configuração obrigatória antes do deploy

| Item | Status mínimo |
|---|---|
| `OPENAI_API_KEY` setado via secrets (NUNCA em código/commit) | ✅ obrigatório |
| `GPT4O_DAILY_BUDGET_USD` configurado pra alertar custo (default `25.0`) | ✅ obrigatório |
| Consent screen do wizard menciona "processamento por OpenAI Inc. (EUA)" | ⚠️ **pendente** (vide seção 7) |
| Política de Privacidade pública lista OpenAI como sub-operador | ⚠️ pendente (jurídico) |
| DPA OpenAI assinada / aceita | ⚠️ pendente (jurídico — verificar em https://platform.openai.com/account/billing) |
| Rotação imediata do token vazado em chat (sk-proj-8PB...ECcA) | ⚠️ pendente (Antonio) |

---

## 6. Estratégia por endpoint (rollback granular)

Cada endpoint tem env var dedicada `OCR_<DOC>_STRATEGY`:

- `legacy` — sem Vision (volta ao comportamento pré-migração)
- `infosimples-with-vision-fallback` — tenta primário, cai pra Vision se falhar
- `vision-only` — usa Vision direto

Default em produção: `legacy` em todos. **Ativação por endpoint após** consent screen + DPA estarem em ordem.

Recomendação operacional (após consent screen):
- `OCR_CNH_STRATEGY=infosimples-with-vision-fallback`
- `OCR_CRLV_STRATEGY=infosimples-with-vision-fallback`
- `OCR_CARTAO_CNPJ_STRATEGY=vision-only`
- `OCR_RNTRC_STRATEGY=vision-only`
- `OCR_COMPROVANTE_STRATEGY=vision-only`
- `OCR_SELFIE_CNH_STRATEGY=vision-only` (sem alternativa)

Rollback: setar a var alvo = `legacy` no `.env` da VPS + `docker compose restart cadastro-ocr`. Zero deploy de código.

---

## 7. ⚠️ TODO ao mergear o wizard cadastro-v2 nesta branch

> Esta branch (`feat/ocr-gpt4o-vision-migration`) partiu de `origin/main`,
> que **não contém o wizard cadastro-v2** (ele vive em
> `feat/ocr-comprovante-cep-numero-only`). Quando os dois branches forem
> integrados (via merge/rebase), o consent screen do wizard precisa ser
> atualizado para incluir o texto abaixo:

### Texto recomendado para `ConsentScreen` (cadastro-v2)

> **Processamento de imagens dos seus documentos**
>
> Os documentos que você envia (CNH, CRLV, cartão CNPJ, comprovantes e
> selfie) são processados por:
>
> - **Lamônica Cargas** — armazenamento por até 24 horas em servidor próprio
>   no Brasil para validação do cadastro.
> - **Infosimples Soluções S.A. (Brasil)** — consulta oficial para CNH/CRLV
>   contra base do Detran/Denatran.
> - **OpenAI, L.L.C. (Estados Unidos)** — extração automática de dados via
>   GPT-4o Vision. Retenção: 30 dias para auditoria; sem uso para treino.
>
> Ao continuar, você concorda com o tratamento desses dados conforme o
> Art. 7º V (execução de contrato) da LGPD.

**Localização do ConsentScreen** (na branch v2):
- Procurar com `grep -r "consentimento\|tratamento de dados" frontend/src/components/driver/cadastro-v2/`
- Alternativa: arquivo costuma se chamar `ConsentScreen.tsx` ou `TermsScreen.tsx`
- Se não existir, criar componente novo e renderizar antes da entrada do wizard (Tela0)

---

## 8. Auditoria / observability

- **Header de envelope:** toda resposta de OCR carrega `header.provider`
  e (quando aplicável) `header.primary_error`. Logs do sidecar capturam.
- **Custo:** `gpt4o_vision.budget_snapshot()` exposto em `/api/status`.
- **Token leak:** `gpt4o_vision.install_log_redactor()` instala
  `logging.setLogRecordFactory` que redacta qualquer string contendo `sk-`
  antes de chegar a um handler. Registrado no lifespan do FastAPI.

---

## 9. Histórico

- **2026-05-21** — Doc criado durante a migração (Fase 2 do branch
  `feat/ocr-gpt4o-vision-migration`). Token leaked no chat foi flagged
  para rotação imediata.
