# AUDIT.md — Vistoria Técnica Staff Engineer

**Branch:** `chore/staff-audit` (fork de `main@952105e`)
**Data:** 2026-05-28
**Escopo:** Frontend (React/Vite/TS) + Backend Node (Express/clean arch) + Sidecar FastAPI + infra
**Modo:** READ-ONLY — nenhum arquivo do código foi alterado.

---

## 0. Sumário executivo (1 página)

O projeto está **saudável em comportamento mas inchado em superfície**. O CI roda, tests passam (617 testes verdes), tipo está OK e o lint não acusa erros — mas o lint não acusa erros **porque a regra de "unused vars" foi desligada** ([frontend/eslint.config.js:23](frontend/eslint.config.js:23)), o que mascara um volume relevante de código morto.

**Os 3 achados mais importantes:**

1. 🚨 **`frontend/src/pages/cadastro/CadastroDocumentos.tsx` (4.626 LOC) é fóssil**. Foi a página da rota `/cadastro` removida em PR #14; ninguém mais importa. Sozinha, é ~8% da base FE em LOC.
2. 🚨 **ESLint do FE com `@typescript-eslint/no-unused-vars: "off"`** mascara 71 exports e 73 tipos não usados detectados por knip. **Backend não tem ESLint nenhum.**
3. 🚨 **God modules concentram complexidade**: 10 arquivos FE > 1k LOC e 6 BE > 1k LOC. Os maiores (`CadastroDocumentos.tsx` 4.6k, `public-leads.js` 2.4k, `read-models.js` 2.2k, `DriverRegistrationWizard.tsx` 1.9k, `service.js` load-claims 1.7k, `DriverPortal.tsx` 1.7k) já estão na zona de risco de manutenção.

**Tests:** 617 verdes (FE 251, BE 366), 9 skipped. Sólido.

**Validação executada:**
- `tsc --noEmit` (FE) → ✅ sem erros
- `eslint .` (FE) → ✅ 0 errors, 25 warnings (com `no-unused-vars` off — leitura enganosa)
- `vitest run` (FE + BE) → ✅ 617 passed
- `knip` (FE) → 30 unused files, 11 unused deps, 71 unused exports, 73 unused types, 2 duplicate exports
- `depcheck` (FE/BE) → 2 unused deps reais no FE + 1 devDep, 1 devDep no BE

**Risco de regressão dos refactors propostos:** baixo. A maioria das remoções são de arquivos com 0 importadores (validado por grep antes de classificar).

---

## 1. Achados por severidade

Cada achado tem: **ID** · **Severidade** · **Evidência** · **Recomendação** · **Risco**.

### 🚨 CRÍTICO

| ID | Achado | Evidência | Recomendação | Risco |
|---|---|---|---|---|
| **C-01** | `CadastroDocumentos.tsx` é dead code | [frontend/src/pages/cadastro/CadastroDocumentos.tsx](frontend/src/pages/cadastro/CadastroDocumentos.tsx) — 4.626 LOC. Único importador é `pages/cadastro/index.ts` (também dead). Knip confirma. Origem: rota `/cadastro` removida no PR #14. | Deletar arquivo + `pages/cadastro/index.ts`. **Mover** `cadastroApi.ts` para `frontend/src/services/cadastroApi.ts` (mais semantico — é OCR/external-API client, não uma "página"). Atualizar 9 imports nos consumers do wizard v2. | Baixo. Confirmado sem importadores externos. |
| **C-02** | ESLint mascara unused code | [frontend/eslint.config.js:23](frontend/eslint.config.js:23) → `"@typescript-eslint/no-unused-vars": "off"`. | Ligar regra com `"warn"` (não error, para não bloquear CI imediatamente). Adicionar `eslint-plugin-unused-imports` para auto-fix de imports. Corrigir warnings em onda dedicada. | Baixo. Aumenta ruído inicial, mas é informativo. |
| **C-03** | Backend sem ESLint | Sem `eslint.config.*` em `backend/`. Sem script `lint` em [backend/package.json](backend/package.json). | Adicionar ESLint flat config + `eslint-plugin-n` (Node) + `eslint-plugin-import`. Sem TS no BE, mas regras puras já capturam unused-vars, ciclos, etc. | Baixo. |

### 🔴 ALTO

| ID | Achado | Evidência | Recomendação | Risco |
|---|---|---|---|---|
| **A-01** | God components no FE | Ranking LOC FE (sem testes):<br>1. CadastroDocumentos.tsx — 4626<br>2. DriverRegistrationWizard.tsx — 1928<br>3. DriverPortal.tsx — 1687<br>4. Leads.tsx — 1383<br>5. Motoristas.tsx — 1329<br>6. DriverClaimPanel.tsx — 1317<br>7. cadastroApi.ts — 1305<br>8. ManageCargas.tsx — 1240<br>9. StepCProprietarioCavalo.tsx — 1075<br>10. DriverCargoDetails.tsx — 1055 | Após eliminar **C-01** (CadastroDocumentos), atacar `DriverRegistrationWizard.tsx`: extrair sub-componentes `useStepXxx()`, lazy-load steps via `React.lazy`. Mesmo padrão para `DriverPortal.tsx` (que CLAUDE.md já marca como god module). | Médio. Mexer em fluxos de produção. Recomendado dividir em PRs por componente. |
| **A-02** | God modules no BE | Ranking LOC BE:<br>1. public-leads.js — 2357<br>2. read-models.js — 2180<br>3. service.js (load-claims) — 1716<br>4. google-sheet-loads.js — 1325<br>5. handlers.js (operator-admin) — 1218<br>6. handlers.js (candidatura) — 1054 | `read-models.js` deveria ser **fatiado por agregado** (drivers / cargos / clientes / routes / vehicles — cada um já tem seu use case em `use-cases/_shared.js`). `public-leads.js` mistura whatsapp queue + pré-cadastro + abuse — separar. | Médio. |
| **A-03** | 30 arquivos FE sem importadores | Knip output ([knip-fe-full.txt](AUDIT.md#anexo-1)). Inclui 22 wrappers Radix UI nunca usados (`alert.tsx`, `avatar.tsx`, `carousel.tsx`, `dropdown-menu.tsx`, `form.tsx`, `pagination.tsx`, `resizable.tsx`, `separator.tsx`, `sheet.tsx`, `sidebar.tsx`, `slider.tsx`, `switch.tsx`, `table.tsx`, `tabs.tsx`, `textarea.tsx`, `toggle.tsx`), além de `ClienteRotasManager.tsx`, `DriverDashboardPanel.tsx`, `ShareCardPreview.tsx`, `LeadValidationBadgeGroup.tsx`, `NavLink.tsx`, `PacoteStopsList.tsx`, `lib/publicLeadValidation.ts`, `lib/shareCardCanvas.ts`, `lib/validators.ts`, `lib/baseRouteValues.ts`, `A1cDadosPessoais.tsx`, `ProgressiveStepHeader.tsx`. | Remover em onda dedicada. **Validar cada um com grep**: o knip não vê dynamic imports / strings, mas o projeto não usa esse padrão. | Baixo. Cada remoção valida com `tsc` + `vitest`. |
| **A-04** | 11 unused dependencies no FE | `@hookform/resolvers`, `@radix-ui/react-avatar`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-separator`, `@radix-ui/react-slider`, `@radix-ui/react-switch`, `@radix-ui/react-tabs`, `@radix-ui/react-toggle`, `react-hook-form`, `react-resizable-panels`, `zod`. Causa raiz: os arquivos que as importavam (Radix wrappers, `ui/form.tsx`) estão na lista A-03. | Remover **DEPOIS** da onda A-03 (senão o build quebra durante a transição). | Baixo, condicional a A-03. |
| **A-05** | 71 unused exports + 73 unused types (FE) | Top ofensores: `cadastroApi.ts` (8 exports, 5 types) — fragmentos do legacy; `loadClaims.ts` (5 exports, 4 types); `readModels.ts` (2 exports, 8 types); `candidaturaApi.ts` (2 exports, 11 types). Lista completa em [knip-fe-full.txt](#anexo). | Tree-shake. Maior parte é "preparei pra usar e nunca usei" — remover. Os tipos `Json`/`Tables*`/`Enums` em `supabase/types.ts` são gerados — não tocar. | Baixo. |
| **A-06** | Duplicate exports (default + named) | [src/components/AspxSyncCard.tsx](frontend/src/components/AspxSyncCard.tsx) — exporta `AspxSyncCard` e `default`. Idem [src/components/driver/StandaloneCadastroDialog.tsx](frontend/src/components/driver/StandaloneCadastroDialog.tsx). | Manter só named exports. Default exports geram inconsistência (call sites podem nomear errado). | Baixo. |
| **A-07** | `application/cadastro/` é semi-dead | [backend/src/application/cadastro/](backend/src/application/cadastro/) tem 3 arquivos (40+111 LOC use cases + test). `application/candidatura/` tem 14 arquivos. Os 2 use cases (`finalizar-cadastro`, `lookup-pis`) ainda têm handler HTTP ativo. | Verificar se o endpoint REST `/api/cadastro/*` ainda é chamado por algum cliente. Se não — remover. Se sim — consolidar em `application/candidatura/`. | Médio. Precisa verificar tráfego prod antes. |
| **A-08** | `frontend/public/test-fixtures/` exposto em /public | Diretório local com 17 arquivos (CNH, CRLV, ANTT, selfies, PDFs reais). Untracked, mas **se commitado, seriam servidos publicamente** em `cargas.grupolamonica.com/test-fixtures/*`. Risco LGPD se contiverem dados reais. | Mover para `frontend/test/fixtures/` ou `frontend/__fixtures__/`. Adicionar `frontend/public/test-fixtures/` em `.gitignore` defensivamente. | Baixo (hoje untracked), mas alto se vazasse. |

### 🟡 MÉDIO

| ID | Achado | Evidência | Recomendação | Risco |
|---|---|---|---|---|
| **M-01** | 3 lugares pra "API clients" no FE | `src/api/candidaturaApi.ts`, `src/services/{loadClaims,readModels,apiClient,aspxAdmin}.ts`, `src/pages/cadastro/cadastroApi.ts`. Convenção inconsistente. | Consolidar em `src/services/` (já é o predominante). Mover `api/candidaturaApi.ts` → `services/candidaturaApi.ts` e `pages/cadastro/cadastroApi.ts` → `services/cadastroApi.ts`. | Baixo. |
| **M-02** | Cross-context coupling no BE | [backend/src/application/operator-admin/read-models.js:5](backend/src/application/operator-admin/read-models.js#L5) importa `createSupabaseAdminClient` de `../google-sheets/google-sheet-loads.js`. Operator-admin não deveria depender de google-sheets. | Mover `createSupabaseAdminClient` para `infrastructure/supabase/admin-client.js` (já é infra). | Baixo. |
| **M-03** | 11 scripts `apply-*-migration*.mjs` | [backend/src/scripts/](backend/src/scripts/): `apply-cargas-casadas-migration.mjs`, `apply-driver-portal-visits-migration.mjs`, `apply-m1-prod.mjs`, `apply-m2-prod.mjs`, `apply-m3-prod.mjs`, `apply-migrations-lbpzkdec.mjs`, `apply-pdr-multi-draft-indexes-migration.mjs`, `apply-pending-driver-registrations-migration.mjs`, `apply-route-single-cliente.mjs`, `apply-schema-audit-route-remodel.mjs`, `apply-sheet-monitor-migration.mjs`. Proliferação de scripts one-off. | Consolidar em **1 migration runner único** com idempotência (já existe esboço em `apply-migrations-lbpzkdec.mjs`). Ou adotar `supabase` CLI (já em uso). Scripts one-off já executados → mover para `backend/src/scripts/_archive/` ou deletar. | Médio. Antes de deletar, confirmar que migrations já foram aplicadas em prod. |
| **M-04** | `react-hooks/exhaustive-deps` violations | 3 warnings em [`OwnerAttributionFormPF.tsx`](frontend/src/components/driver/cadastro-v2/widgets/OwnerAttributionFormPF.tsx), [`OwnerAttributionFormPJ.tsx`](frontend/src/components/driver/cadastro-v2/widgets/OwnerAttributionFormPJ.tsx), [`useAuth.tsx`](frontend/src/hooks/useAuth.tsx). | Auditar cada caso. Risco de bug sutil (state stale) em hooks. | Médio. |
| **M-05** | State global mutável no BE | [backend/src/application/load-claims/public-leads.js:31](backend/src/application/load-claims/public-leads.js#L31) — `savepointSupportByClient = new WeakMap()`. [backend/src/application/operator-admin/read-models.js:17](backend/src/application/operator-admin/read-models.js#L17) — `operatorDirectoryCache`. | Aceitável em single-replica (CLAUDE.md confirma). Documentar no DC-95 (Redis migration). Não bloquear deploy. | Baixo agora, alto se virar multi-replica. |
| **M-06** | `backend/src/examples/get-route-info.example.js` é dead | 1 arquivo, sem importadores em `backend/src/**`. | Mover para `docs/snippets/` ou deletar. | Baixo. |
| **M-07** | Backend sem typecheck | Backend é JS puro (sem TS). Não há `jsconfig.json` + `// @ts-check`. Tipagem 0. | Adicionar `// @ts-check` no topo dos use cases mais críticos (`load-claims/service.js`, `cargas-casadas/atomic-claim.js`) + `jsconfig.json` com `checkJs: true`. Refactor para TS está fora de escopo. | Médio. Migração inteira para TS é projeto separado. |
| **M-08** | `tinybench` unused no BE | [backend/package.json:41](backend/package.json#L41). Mas tem scripts `bench`, `bench:db`, `bench:app`. Provavelmente vitest usa tinybench internamente. | Validar: rodar `npm run bench` antes de remover. Se passar sem ele, remover. | Baixo. |

### 🟢 BAIXO

| ID | Achado | Evidência | Recomendação |
|---|---|---|---|
| **B-01** | Arquivo lixo no FE | `frontend/Ctmpfrontend.log` — 16 bytes. Origem provável: `> Ctmpfrontend.log` que criou arquivo literal. | Deletar. |
| **B-02** | Múltiplos `.env*` no FE | `.env`, `.env.clone`, `.env.development.local`. Todos no `.gitignore`, OK, mas há indireção em quantos modos rodam. | Documentar em `frontend/README.md` cada `.env.*`. |
| **B-03** | ESLint config minimalista | [frontend/eslint.config.js](frontend/eslint.config.js) — só `recommended` + react-hooks + react-refresh. Sem `no-explicit-any`, `complexity`, `max-lines-per-function`. | Após C-02, adicionar regras seletivas: `complexity: ["warn", 15]`, `max-lines: ["warn", 500]` (vai gritar nos god modules → bom). |
| **B-04** | `cross-env` flagged por depcheck | Falso-positivo: usado em scripts do package.json. **Não remover.** | Ignorar. |
| **B-05** | `autoprefixer` + `postcss` flagged por depcheck | Falso-positivo: usados pelo `postcss.config.js`. **Não remover.** | Ignorar. |
| **B-06** | `@tailwindcss/typography` unused | Não referenciado em `tailwind.config.ts` nem no código. | Remover. |
| **B-07** | `pages/cadastro/index.ts` é dead | Re-exporta `CadastroDocumentos` (dead em C-01) e `cadastroApi` (que vai mudar de lugar em C-01). | Deletar junto com C-01. |
| **B-08** | `backend.env` referenciado em `.gitignore` mas não existe | Linha 33 do .gitignore. Defensivo, ok. | Manter. |
| **B-09** | `prod_schema.sql` 12.9 MB local | Ignorado, OK. | Manter no .gitignore. |

---

## 2. Achados por subsistema

### 2.1 Frontend

- **254 arquivos** `.ts/.tsx/.js/.jsx` em `src/`, ~57.000 LOC sem testes.
- **42 test files**, 251 testes passando, 4 skipped. Cobertura focada em hooks/utils/services + alguns componentes (DashboardLayout, DriverPortal, AdminLogin).
- 30 arquivos sem importadores (knip) — 22 são Radix wrappers, 8 são módulos de feature.
- Padrões aplicados:
  - shadcn/ui (Radix) — OK, mas usado parcialmente. Muitos wrappers foram instalados antes de serem necessários.
  - TanStack Query — OK, padrão consistente.
  - React Hook Form — **instalado mas não usado**. Os componentes do wizard v2 usam state controlado (`useState`) ao invés de RHF. **Decisão pendente**: ou padronizar em RHF ou remover.
  - zod — **instalado mas não usado** no FE. Backend usa, FE espelha tipos via TanStack Query response types.
  - lucide-react — usado heavily, OK.
- Configs OK exceto pelo `no-unused-vars: "off"` (C-02).

### 2.2 Backend

- **193 arquivos** `.js/.mjs` em `src/`, ~33.000 LOC.
- **44 test files**, 366 testes passando, 5 skipped.
- Clean architecture aplicada com **disciplina razoável**:
  - `domain/` puro, sem deps externas — OK
  - `application/use-cases/` por bounded context — OK
  - `infrastructure/` adapters bem isolados — OK
  - `interface/http/` por bounded context — OK
- Problemas:
  - Ausência total de ESLint (C-03)
  - Sem typecheck (M-07)
  - God modules `read-models.js` e `public-leads.js` (A-02)
  - Cross-context coupling read-models → google-sheets (M-02)
  - Pasta `examples/` dead (M-06)
  - 11 scripts apply-migration (M-03)
- Tests robustos. RLS behavior testado, idempotência testada, rate-limit testado.

### 2.3 Sidecar FastAPI (`cadastro-motorista/`)

- 17 arquivos `.py/.ts/.tsx` (não auditado em profundidade nesta passada).
- Continua ativo mesmo após remoção da rota `/cadastro` (CLAUDE.md confirma).
- **Recomendação:** auditoria dedicada futura — fora do escopo desta sessão.

### 2.4 Infra

- `docker-compose.yml` + `docker-compose.override.yml` (dev) + `docker-compose.vps.yml` (prod) + `docker-compose.domain.yml`. **4 compose files** — verificar se `vps.yml` e `domain.yml` ainda são usados (CLAUDE.md menciona só `.yml` + `.override.yml` + `.deploy.yml`). Inconsistência.
- GHA workflows: não auditado nesta passada.

---

## 3. Plano de ondas (refactor)

Cada onda = **1 PR**, em branch própria a partir de `main`. Ordem importa por dependência.

### Onda 1 — Limpeza de dead code FE
**Branch:** `chore/wave-1-dead-code-fe`
**Escopo:** C-01, A-03, A-04 (deps depois dos arquivos), A-06 (duplicate exports), B-01, B-06, B-07
**Esforço estimado:** 150-300 LOC delta (mas remove milhares)
**Conventional commits sugeridos:**
```
chore(cadastro): remove CadastroDocumentos.tsx fossil from removed /cadastro route
chore(cadastro): move cadastroApi.ts from pages/cadastro to services/
chore(ui): remove unused Radix wrappers (alert, avatar, carousel, ...)
chore(driver): remove unused components (DriverDashboardPanel, ShareCardPreview, ...)
chore(lib): remove unused modules (publicLeadValidation, shareCardCanvas, validators)
chore(deps): drop unused deps (zod, react-hook-form, @hookform/resolvers, @tailwindcss/typography, 8 Radix-*)
fix(components): remove default exports from AspxSyncCard, StandaloneCadastroDialog
chore: delete Ctmpfrontend.log artifact
```
**Validação:** `tsc --noEmit && eslint . && vitest run && vite build` em cada commit.

### Onda 2 — Activar ESLint adequado
**Branch:** `chore/wave-2-eslint-hardening`
**Escopo:** C-02, C-03, B-03
**Esforço estimado:** 50 LOC delta (configs) + correções automáticas
**Conventional commits:**
```
chore(eslint): re-enable no-unused-vars and add unused-imports plugin
chore(eslint): add ESLint flat config for backend (Node + import rules)
ci: add backend lint to CI workflow
chore(eslint): add complexity/max-lines warn-level rules (no breaking)
```

### Onda 3 — Tree-shake exports e tipos não usados
**Branch:** `chore/wave-3-tree-shake-exports`
**Escopo:** A-05
**Esforço estimado:** ~200 LOC delta
**Conventional commits:**
```
refactor(cadastroApi): remove unused exports and types
refactor(loadClaims): remove unused public helpers
refactor(readModels): tree-shake unused exports
refactor(candidaturaApi): remove unused types
refactor(driver/cadastro-v2): inline single-use types from step components
```

### Onda 4 — Refactor god modules (BE first, menor risco)
**Branch:** `chore/wave-4-split-read-models` (1ª de várias)
**Escopo:** A-02 (`read-models.js`), M-02 (mover `createSupabaseAdminClient`)
**Esforço estimado:** redistribui ~2200 LOC em 5 use cases (~440 LOC cada)
**Conventional commits:**
```
refactor(supabase): move admin-client to infrastructure layer
refactor(operator-admin): extract drivers read-model into use-case file
refactor(operator-admin): extract cargos read-model
refactor(operator-admin): extract clientes/routes/vehicles read-models
test(operator-admin): keep coverage on 2k+ extracted lines
```

### Onda 5 — Split `public-leads.js` (BE)
**Branch:** `chore/wave-5-split-public-leads`
**Escopo:** A-02 (`public-leads.js`)
**Esforço:** redistribui ~2400 LOC

### Onda 6 — Limpeza de scripts BE
**Branch:** `chore/wave-6-migrate-scripts`
**Escopo:** M-03, M-06, A-07, M-08
**Esforço:** consolida 11 scripts em 1 runner + arquiva legados
```
chore(scripts): consolidate apply-*-migration scripts into single idempotent runner
chore(scripts): archive one-off migration scripts already applied to prod
chore(backend): remove examples/get-route-info.example.js dead snippet
chore(deps): drop tinybench unused devDep
```

### Onda 7+ — Refactor god components FE
**Branches:** `chore/wave-7-split-driver-wizard`, `chore/wave-8-split-driver-portal`, etc.
**Escopo:** A-01
**Esforço:** **alto, isolado por arquivo**. Cada componente em PR separado.
**Aviso:** SÓ após ondas 1-3 fecharem — base mais limpa = refactor menos arriscado.

### Onda N — A-08 (fixtures fora de /public)
**Branch:** `chore/test-fixtures-move`
**Escopo:** mover `frontend/public/test-fixtures/` para `frontend/test/fixtures/` + gitignore defensivo.
**Pode ser feita a qualquer momento** (não bloqueia outras ondas).

---

## 4. Pontos críticos remanescentes (riscos)

1. **`application/cadastro/` ambíguo** (A-07): antes de remover, validar que o endpoint REST `/api/cadastro/finalizar` e `/api/cadastro/lookup-pis` não estão sendo chamados em produção. Checar logs do Express.
2. **Tinybench falso-positivo possível** (M-08): rodar `npm run bench` antes de remover.
3. **`react-hook-form` removível?** (A-04): só remover depois de validar que `components/ui/form.tsx` (que é o único consumer) está realmente sem uso. Knip + grep confirmam, mas vale dupla checagem.
4. **God components em produção** (A-01): refatorar `DriverPortal.tsx` e `DriverRegistrationWizard.tsx` em PRs separados, isolados, **com testes E2E manuais** antes do merge — esses são fluxos críticos do operador e do motorista.
5. **Migrations já aplicadas?** (M-03): antes de arquivar scripts, confirmar via `supabase migration list` que todas estão registradas.

---

## 5. Comandos executados nesta auditoria

```powershell
# Branch setup
git fetch origin --prune
git checkout main && git pull origin main --ff-only
git checkout -b chore/staff-audit

# Inventário
find {frontend,backend}/src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" \) | wc -l
find frontend/src -type f -name "*.ts*" -not -name "*.test.*" | xargs wc -l | sort -rn

# Estática
cd frontend && npx --no-install tsc --noEmit -p tsconfig.json
cd frontend && npx --no-install eslint . --format json > eslint-fe.json
cd backend && npx --no-install vitest run --reporter=dot
cd frontend && npx --no-install vitest run --reporter=dot
cd frontend && npx -y knip --no-progress
cd frontend && npx -y depcheck --json
cd backend && npx -y depcheck --json

# Validação manual
grep -rE "from ['\"].*pages/cadastro" frontend/src --include="*.ts*"
grep -rE "from ['\"].*application/cadastro" backend/src --include="*.js"
```

---

## 6. Métricas finais

| Métrica | Valor |
|---|---|
| FE arquivos source | 254 |
| FE LOC (sem teste) | ~57.000 |
| BE arquivos source | 193 |
| BE LOC (sem teste) | ~33.000 |
| Tests passando (FE+BE) | 617 |
| Tests skipped | 9 |
| God modules > 1k LOC | 16 |
| Maior arquivo | CadastroDocumentos.tsx (4626 LOC) |
| FE unused files (knip) | 30 |
| FE unused deps (real) | 12 (após validar falso-positivos) |
| FE unused exports | 71 |
| FE unused types | 73 |
| BE unused deps | 1 (tinybench, validar antes) |
| ESLint warnings | 25 (mas mascarado por config) |
| Branches/main | 1 (`chore/staff-audit`) |
| Untracked artifacts | 3 (`.split-branches/`, script avulso, test-fixtures) |

---

## 7. Próximos passos sugeridos

1. **Você revisa este AUDIT.md** e decide quais ondas executar.
2. Para cada onda aprovada, eu **crio branch dedicada a partir de `main`** + abro PR pequeno seguindo CONTRIBUTING.md.
3. **Onda 1 (limpeza FE) é a melhor primeira execução** — risco baixo, payoff alto (~5k+ LOC removidos, deps removidas, lint mais honesto).
4. **Onda 2 (ESLint)** logo após — base para evitar regressão.

Pronto para Onda 1 se autorizar. Não toquei em código fora deste AUDIT.md.

---

*Auditoria executada em modo read-only. Branch `chore/staff-audit` contém apenas este arquivo.*
