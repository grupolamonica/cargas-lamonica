# Lamonica Cargas — Project Guide for Claude Code

## ⚠ Norma de engenharia (LER PRIMEIRO)

**Toda contribuição neste repositório — humana ou via Claude Code — DEVE seguir o [`CONTRIBUTING.md`](./CONTRIBUTING.md).**

Este documento é a **fonte da verdade** sobre:
- Estrutura de branches (`feature/`, `fix/`, `hotfix/`, `release/`)
- **Conventional Commits** (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, `build`, `ci`, `chore`, `revert`)
- Pull Request profissional (template em `.github/PULL_REQUEST_TEMPLATE.md`)
- Política de review e CODEOWNERS
- Squash and merge obrigatório
- Proteções de `main` (sem push direto, sem force push, CI obrigatório, histórico linear)
- Versionamento SemVer + tags + release notes
- Fluxo de hotfix em produção
- Política de tamanho de PR (até 300 linhas ideal; 1000+ proibido)

**Regras inegociáveis para o Claude Code ao operar neste projeto:**

1. **NUNCA fazer push direto na `main`.** Sempre criar branch (`feature/`, `fix/`, `hotfix/`).
2. **NUNCA usar commits genéricos** como "ajustes", "correção", "final". Sempre Conventional Commits com escopo.
3. **Separar commits por mudança lógica** — um commit responde "qual decisão técnica foi feita aqui?".
4. **Antes de qualquer commit/push**, validar que está seguindo o `CONTRIBUTING.md`.
5. **NUNCA usar `--force`** em push. Apenas `--force-with-lease` quando absolutamente necessário (após rebase).
6. **NUNCA pular hooks** (`--no-verify`) sem autorização explícita do usuário.
7. **Antes de abrir PR**, rodar lint + tests + build localmente.
8. **PR pequeno e objetivo.** Se a mudança ficar >600 linhas, sugerir quebra antes de continuar.
9. **Hotfix é exceção, não rotina** — exige autorização explícita e segue fluxo dedicado.
10. **Secrets/tokens nunca no código.** Verificar antes de cada commit.

## Project

**Lamonica Cargas** (LMC) — Plataforma logística full-stack para operação de cargas, clientes, leads e portal do motorista.

**Em produção:** `https://cargas.grupolamonica.com` (VPS + Docker + Traefik). Deploy automatizado via GitHub Actions a cada push na `main`.

**Milestone v1 (`v1-refactor-arch-docker-vps`) — CONCLUÍDO** (Phases 1-6: split estrutural + clean architecture, runtime Express, Docker, comunicação/env, CI/CD + deploy VPS, hardening). O sub-repo legado `lan-a-cargas-main` foi removido.

**Foco atual — entrega de features pós-refactor:**
- **Cadastro v2** — wizard do motorista (candidatura a partir de carga **e** cadastro avulso pelo botão "Cadastro"), cascata ANTT, OCR via sidecar FastAPI. A rota pública `/cadastro` foi **removida** (cadastro só via wizard de candidatura/standalone).
- **Painel do operador + Sheet Monitor** — fixes de enriquecimento (consulta só pendentes), revisão de ficha completa, KPIs.
- **Cargas Casadas** (multi-stop, claim atômico) — em andamento.

## GSD Workflow

Este projeto usa **GSD** (Get Shit Done). Planejamento em `.planning/` (local-only, não commitado — multi-repo workspace).

**Artefatos principais:**
- `.planning/PROJECT.md` — contexto, core value, requirements hypotheses, decisões
- `.planning/REQUIREMENTS.md` — 35 v1 REQ-IDs em 6 categorias (STRUCT, RUNTIME, DOCKER, COMM, CICD, CLEAN)
- `.planning/ROADMAP.md` — 5 phases sequenciais
- `.planning/STATE.md` — posição atual, progresso, contexto acumulado
- `.planning/codebase/` — análise do código existente (ARCHITECTURE, STACK, STRUCTURE, INTEGRATIONS, CONCERNS, CONVENTIONS, TESTING)

**Config:** `.planning/config.json` — `mode: yolo`, `granularity: coarse`, `parallelization: sequential`, `workflow: { research: false, plan_check: true, verifier: true }`. (O sub-repo `lan-a-cargas-main` foi removido na Phase 5.)

**Rastreamento no Jira:** projeto **DC** (`Desenvolvimento CargasLamonica`). Convenções de board na issue **DC-101**; automação commit↔Jira em [`docs/JIRA-WORKFLOW.md`](./docs/JIRA-WORKFLOW.md) (slash `/jira-sync`).

**Comandos úteis:** `/gsd-progress` (status), `/gsd-quick` (tarefa pequena), `/gsd-plan-phase` (decompor nova fase), `/jira-sync` (sincronizar commits com o Jira).

## Architecture (estado atual — pós-refactor)

```
Cargas_Lamonica/                    ← Monorepo (um único .git)
├── frontend/                       ← React 18 + Vite 6 + TS; Dockerfile multi-stage → nginx:alpine
│   └── src/modules/cadastro-motorista/  ← (legado da rota /cadastro removida)
├── backend/                        ← Node.js 22 ESM + Express v4; clean architecture
│   │                                  (domain / application / infrastructure / interface)
│   ├── Dockerfile                  ← node:22-slim, porta 3001
│   └── supabase/                   ← Migrations + bootstrap RLS
├── cadastro-motorista/backend/     ← Sidecar FastAPI (Python, :8765) — OCR + consultas externas
├── docker-compose.yml              ← frontend + backend + Traefik (overrides: .override dev / .deploy prod)
├── .github/workflows/              ← ci.yml + deploy.yml (GHCR → SSH VPS) + rollback.yml
├── docs/                           ← README de infra, runbooks, JIRA-WORKFLOW.md
└── .planning/                      ← GSD docs (local-only, gitignored salvo STATE.md + alguns summaries)
```

> Fluxo de cadastro v2: `frontend` (wizard) → `backend` Express (`/api/candidatura/*`, persistência + cascata ANTT) → sidecar FastAPI (`/api/consulta/*`, OCR + Infosimples/ANTT/ViaCEP). O sidecar FastAPI continua ativo mesmo após a remoção da rota React `/cadastro`.

## Tech Stack

**Frontend:** React 18.3 / Vite 6 / TypeScript 5.8 / TanStack Query v5 / React Router v6 / shadcn/ui (Radix) / Tailwind 3.4 / next-themes
**Backend:** Node.js 22 ESM + Express v4 / pg 8 / @supabase/supabase-js / zod 3 / vitest 3
**Sidecar OCR:** FastAPI (Python, `:8765`) em `cadastro-motorista/backend/` — OCR de documentos + consultas (Infosimples, ANTT, DENATRAN, ViaCEP)
**Database:** PostgreSQL via Supabase (managed, external) — direct pg connection (pgBouncer transaction mode) + RLS via `current_app_role()`
**Auth:** Supabase Auth dupla (operator: `lamonica-operator-auth` / driver: `lamonica-driver-auth`) com clientes separados
**Integrações externas:** Angellira (validação CPF), ASPX directory (CSV), Google Sheets (Shopee sync), Infosimples/ANTT (via sidecar). _Geoapify removido (routing/geocoding) — ver DC-83._

## Deployment

**Atual (produção):** VPS (`76.13.169.177`, domínio `cargas.grupolamonica.com`) com Docker + docker-compose + Traefik v3 (TLS automático via Let's Encrypt) + GHCR como registry. _Vercel foi descontinuado._
**CI/CD:** GitHub Actions — `push main` → `ci.yml` (lint+typecheck+test+build) + `deploy.yml` (gate de test → build imagens paralelas → push GHCR → SSH deploy VPS `docker compose pull && up -d` → smoke test). Rollback via `rollback.yml` (workflow_dispatch com SHA).
**Operação:** ver [`README.md`](./README.md) (secrets, first-time setup, rollback, TLS, backup, smoke tests). Antes de mergear/deployar: `scripts/pre-deploy-check.sh`.

## Conventions (do refactor)

- **Clean Architecture layers no backend:**
  - `domain/` — entidades + regras puras, sem deps externas
  - `application/` — use cases (orquestração), consome domain + portas infrastructure
  - `infrastructure/` — adapters (pg, supabase-admin, Geoapify, Angellira, ASPX, Google Sheets)
  - `interface/http/` — handlers HTTP por bounded context (operator-admin, load-claims, public-loads, aspx-admin)
- **No backend refactor**: preservar 100% dos 40+ endpoints existentes. Só mudar organização de arquivos + runtime (Vercel → HTTP server persistente).
- **Idempotência**: `Idempotency-Key` header em mutações de load-claims — preservar.
- **Correlation IDs**: `X-Correlation-Id` em todas as requests — preservar.

## Out of Scope (do milestone v1-refactor — histórico)

Estes eram limites do **refactor** (concluído). Migração de Supabase, Kubernetes e
reescrita de regras de negócio seguem fora de escopo. O refactor dos god modules
(`operator-admin/service.js`, `DriverPortal.tsx`) foi feito além do mínimo nas
features pós-refactor (split de hooks/use-cases — ver DC-66/DC-68). Mudanças de
UI/UX, que eram out-of-scope do refactor, passaram a ser trabalho de feature
(redesign do portal, wizard cadastro v2).

## Known Issues

- **H-01** (RESOLVIDO): estado em memória (idempotency cache, circuit breakers, rate limiters) quebrava em serverless — resolvido pela migração para container persistente (Phase 2/3).
- **H-03** (RESOLVIDO): `ALLOWED_ORIGINS` documentado em `.env.example` (Phase 4).
- Limitação atual conhecida: rate limiters/idempotency são in-memory (não cluster-safe) — aceitável em single-replica; upgrade futuro para Redis rastreado em DC-95 (Phase 9, Sprint 1).
- Histórico do codebase legado em `.planning/codebase/CONCERNS.md`.

---
*Gerado em 2026-04-24 durante `/gsd-new-project` init. Atualizado em 2026-05-27 (milestone v1 concluído + features pós-refactor).*
