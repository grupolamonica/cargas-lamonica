# Lamonica Cargas — Project Guide for Claude Code

## Project

**Lamonica Cargas** (LMC) — Plataforma logística full-stack para operação de cargas, clientes, leads e portal do motorista.

**Current milestone:** `v1-refactor-arch-docker-vps` — refactor estrutural brownfield para clean architecture, split físico front/back, containerização Docker, deploy automatizado em VPS via GitHub Actions.

## GSD Workflow

Este projeto usa **GSD** (Get Shit Done). Planejamento em `.planning/` (local-only, não commitado — multi-repo workspace).

**Artefatos principais:**
- `.planning/PROJECT.md` — contexto, core value, requirements hypotheses, decisões
- `.planning/REQUIREMENTS.md` — 35 v1 REQ-IDs em 6 categorias (STRUCT, RUNTIME, DOCKER, COMM, CICD, CLEAN)
- `.planning/ROADMAP.md` — 5 phases sequenciais
- `.planning/STATE.md` — posição atual, progresso, contexto acumulado
- `.planning/codebase/` — análise do código existente (ARCHITECTURE, STACK, STRUCTURE, INTEGRATIONS, CONCERNS, CONVENTIONS, TESTING)

**Config:** `.planning/config.json` — `mode: yolo`, `granularity: coarse`, `parallelization: sequential`, `sub_repos: ["lan-a-cargas-main"]`, `workflow: { research: false, plan_check: true, verifier: true }`.

**Próximos passos:**
- `/gsd-plan-phase 1` — decompor Phase 1 (Structural Split) em planos executáveis
- `/gsd-execute-phase 1` — executar os planos após criados
- `/gsd-progress` — checar status em qualquer momento

## Architecture (current → target)

### Current state
```
Cargas_Lamonica/                    ← Workspace (sem .git)
├── src/                            ← Demo legacy (static data) — a remover
├── backend/                        ← Stub legacy — a remover
└── lan-a-cargas-main/              ← PRODUCTION (tem .git — sub-repo)
    ├── api/[...route].mjs          ← Vercel catch-all serverless
    ├── frontend/                   ← React 18 + Vite 6 + TS
    ├── backend/                    ← Node.js ESM + pg + Supabase Admin
    └── supabase/                   ← Migrations + bootstrap RLS
```

### Target state (pós-refactor)
```
Cargas_Lamonica/
├── frontend/                       ← Package.json próprio, Dockerfile multi-stage → nginx
├── backend/                        ← Package.json próprio, clean architecture (domain/application/infrastructure/interface), Dockerfile → node slim
│   └── supabase/                   ← Migrations mantidas aqui
├── docker-compose.yml              ← frontend + backend + Traefik
├── .github/workflows/deploy.yml    ← build → GHCR → SSH deploy VPS
└── .planning/                      ← GSD docs (local-only)
```

## Tech Stack (preservado no refactor)

**Frontend:** React 18.3.1 / Vite 6.4.2 / TypeScript 5.8.3 / TanStack Query v5 / React Router v6 / shadcn/ui (Radix) / Tailwind 3.4.17 / next-themes
**Backend:** Node.js ESM (`.mjs`) / pg 8.16 / @supabase/supabase-js / zod 3.25 / vitest 3.2
**Database:** PostgreSQL via Supabase (managed, external) — direct pg connection + RLS via `current_app_role()`
**Auth:** Supabase Auth dupla (operator: `lamonica-operator-auth` / driver: `lamonica-driver-auth`) com clientes separados
**Integrações externas:** Geoapify (routing/geocoding), Angellira (CPF validation), ASPX directory (CSV), Google Sheets (Shopee sync)

## Deployment

**Atual:** Vercel (serverless functions + static CDN, Cloudflare na frente)
**Target:** VPS com Docker + docker-compose + Traefik (TLS automático via Let's Encrypt) + GHCR como registry
**CI/CD target:** GitHub Actions — `push main` → test → build imagens paralelas → push GHCR → SSH deploy VPS (`docker compose pull && up -d`)

## Conventions (do refactor)

- **Clean Architecture layers no backend:**
  - `domain/` — entidades + regras puras, sem deps externas
  - `application/` — use cases (orquestração), consome domain + portas infrastructure
  - `infrastructure/` — adapters (pg, supabase-admin, Geoapify, Angellira, ASPX, Google Sheets)
  - `interface/http/` — handlers HTTP por bounded context (operator-admin, load-claims, public-loads, aspx-admin)
- **No backend refactor**: preservar 100% dos 40+ endpoints existentes. Só mudar organização de arquivos + runtime (Vercel → HTTP server persistente).
- **Idempotência**: `Idempotency-Key` header em mutações de load-claims — preservar.
- **Correlation IDs**: `X-Correlation-Id` em todas as requests — preservar.

## Out of Scope (reforço)

- Migração de Supabase para outro provider
- Reescrita de regras de negócio
- Mudanças de UI/UX
- Kubernetes (docker-compose é suficiente)
- Refactor dos god modules (`operator-admin/service.js` 2771L, `DriverPortal.tsx` 2107L) além do mínimo para separar camadas

## Known Issues (do codebase legacy, tratados pelo refactor)

- **H-01**: Estado em memória (idempotency cache, circuit breakers, rate limiters) quebra em serverless. Migração para container persistente **resolve isso automaticamente**.
- **H-03**: `ALLOWED_ORIGINS` não documentado em `.env.example`. A ser corrigido em Phase 4 (COMM-05).
- Detalhes em `.planning/codebase/CONCERNS.md`.

---
*Gerado em 2026-04-24 durante `/gsd-new-project` init*
