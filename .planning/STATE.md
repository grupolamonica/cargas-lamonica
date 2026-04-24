---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
stopped_at: Completed 03-02-PLAN.md
last_updated: "2026-04-24T16:57:19.499Z"
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 5
  completed_plans: 8
  percent: 100
---

# Project State — Lamonica Cargas

**Project:** Lamonica Cargas (LMC)
**Milestone:** v1-refactor-arch-docker-vps
**Last updated:** 2026-04-24

## Project Reference

**Core value:** Independência de infraestrutura e clareza arquitetural — deploy controlado em VPS próprio (substitui Vercel), módulos desacoplados (front/back evoluem separadamente), pipeline CI/CD reprodutível.

**Current focus:** Refactor estrutural brownfield. Preserva 100% da lógica de negócio e integrações. Não é reescrita.

**Type:** Brownfield refactor (estrutura + runtime + DevOps)
**Granularity:** coarse (5 phases)
**Parallelization:** sequential
**Sub-repos:** `lan-a-cargas-main` (REMOVED — cleanup complete)

## Current Position

**Phase:** 3 — IN PROGRESS
**Plan:** 1/N complete
**Status:** Phase 3 Plan 1 complete — frontend/Dockerfile (node:22-slim → nginx:alpine) + nginx.conf + .dockerignore
**Progress:** [██████████] 100%

```
Phase 1: Structural Split + Clean Architecture   [x] COMPLETE (Plans 1+2+3+4 done)
Phase 2: Backend Runtime Migration               [x] COMPLETE (Plans 1+2 done)
Phase 3: Dockerization                           [~] In progress (Plan 1/N done)
Phase 4: Communication & Env Configuration       [ ] Not started
Phase 5: CI/CD + VPS Deploy + Cleanup            [ ] Not started
```

## Performance Metrics

- **Requirements coverage:** 35/35 v1 REQ-IDs mapped (100%)
- **Phases defined:** 5
- **Plans created:** N/A (GSD phase plans)
- **Plans complete:** 4 (Phase 1 all plans done)

| Phase | Plan | Duration | Tasks | Files | Completed |
|-------|------|----------|-------|-------|-----------|
| 1 | 1 | ~60min | 2/2 | 14 created, 1 modified | 2026-04-24 |
| 1 | 2 | ~90min | 2/2 | 141 created, 2 modified | 2026-04-24 |
| 1 | 3 | ~3min | 2/2 | 5 created, 3 modified | 2026-04-24 |
| 1 | 4 | ~25min | 2/2 | 6 created, 5 modified, 98 deleted | 2026-04-24 |
| Phase 02-backend-runtime-migration P01 | 2min | 2 tasks | 3 files |
| Phase 02-backend-runtime-migration P02 | 3min | 2 tasks | 2 files |
| 3 | 1 | ~5min | 2/2 | 3 created | 2026-04-24 |
| Phase 03-dockerization P02 | 5m | 2 tasks | 2 files |

## Accumulated Context

### Key Decisions

| Decision | Context | Status |
|----------|---------|--------|
| Sair da Vercel para VPS | VPS dá controle total, elimina cold starts, resolve H-01 (state mismatch), reduz custo recorrente | Approved (in PROJECT.md) |
| Clean architecture (domain/application/infrastructure/interface) | Separar regras de negócio de integrações externas; facilita testes e evolução | Approved |
| Docker Compose (não k8s) | Escala atual não justifica k8s; compose é simples de operar em VPS single-host | Approved |
| GHCR como registry | Integração nativa com GitHub Actions, free para repos privados sob org | Approved |
| Traefik como reverse proxy | TLS automático (Let's Encrypt), descoberta por labels, zero-config para novos containers | Provisional — confirmar na Phase 3 |
| Monorepo (não split repos) | Único repo com `frontend/` + `backend/` facilita contracts e deploy atômico | Approved |
| Backend HTTP framework: Express v4 | Express escolhido — brownfield-friendly, zero-drama, middleware porta direto de api/[...route].mjs | Approved (Phase 2 Plan 1) |
| No pg in frontend package.json | Strict dep boundary: frontend deps only in frontend, backend deps only in backend | Approved (Phase 1 Plan 1) |
| VITE_API_BASE_URL default empty string | Backward-compatible with Vercel (empty = /api/*), set for local dev | Approved (Phase 1 Plan 1) |
| shared/types/ centralizado no root | Tipos de domínio em shared/types/domain.ts; Supabase infra types em cada módulo via CLI | Approved (Phase 1 Plan 3) |
| PaginationMeta em api.ts (não domain.ts) | É contrato wire-format, não entidade de domínio | Approved (Phase 1 Plan 3) |
| date-fns declarado explicitamente no backend | Dependência implícita via root node_modules exposta após cleanup — adicionada a backend/package.json | Approved (Phase 1 Plan 4) |
| @testing-library/dom declarado explicitamente no frontend | Peer dep de @testing-library/react — adicionada a frontend/package.json | Approved (Phase 1 Plan 4) |
| Scripts Python em scripts/ (não externalizar) | Mantidos no repo como utilitários manuais; sem Dockerfile nem build step | Approved (Phase 1 Plan 4) |
| PORT default=3001 | Alinha com frontend/vite.config.ts proxy target já configurado | Approved (Phase 2 Plan 1) |
| Supabase health = config check (não round-trip) | Docker healthcheck rápido e determinístico — Supabase é serviço externo gerenciado | Approved (Phase 2 Plan 1) |
| CORS portado manualmente (sem pacote cors) | Manter lógica fail-closed exata de api/[...route].mjs sem divergência comportamental | Approved (Phase 2 Plan 1) |
| withParams adapter em vez de modificar handlers | Preserva 100% da lógica de negócio existente no Express sem reescrita | Approved (Phase 2 Plan 2) |
| Ordem de registro fixas antes parametrizadas | Express resolve por ordem de registro — /cargas/sync-sheet antes de /cargas/:cargoId (T-02-07) | Approved (Phase 2 Plan 2) |
| node:22-slim (floating 22.x) para frontend builder | Satisfaz engines.node >=18.0.0; usa npm ci (lockfile presente, builds reprodutíveis) | Approved (Phase 3 Plan 1) |
| VITE_* ARGs com default empty string no Dockerfile | Backward-compat com dev (empty = /api/* relativo); sem segredo no frontend image | Approved (Phase 3 Plan 1) |
| nginx:alpine runtime (não node) | Footprint mínimo <200MB; serve static assets eficientemente | Approved (Phase 3 Plan 1) |

### Decisions Pending

- **Traefik vs alternativa (Phase 3):** Confirmar Traefik ou avaliar Caddy/Nginx com certbot no VPS.

### Active Todos

- Plan + Execute Phase 3 (Dockerization) — context captured 2026-04-24, decisions locked

### Blockers

Nenhum.

### Open Questions

- Domínio de produção final para CORS + Traefik? (resposta necessária antes da Phase 4)
- VPS provisionado? Host, usuário SSH, estrutura de diretórios já definidos? (resposta necessária antes da Phase 5)
- Branch de deploy: `main` ou `production` separada? (Phase 5)

## Brownfield Constraints (must not break)

Validated capabilities from PROJECT.md — todas devem continuar funcionando ao final de cada fase:

- Portal do motorista (auth Supabase driver, claim de cargas, state machine)
- Dashboard operador (CRUD cargas/clientes/rotas, leads, métricas, auditoria)
- API REST 40+ endpoints documentados em INTEGRATIONS.md
- Integrações: Supabase (Auth + DB + RLS), Geoapify, Angellira, ASPX, Google Sheets
- Circuit breakers nativos (Geoapify, Angellira, ASPX)
- Idempotency-Key em load-claim mutations
- Autenticação dupla (operator + driver) com clientes Supabase separados
- RLS via `current_app_role()`
- Testes vitest + Playwright E2E

## Session Continuity

**Stopped at:** Completed 03-02-PLAN.md

**Next action:** Execute Phase 3 Plan 2+ — backend Dockerfile, docker-compose.yml, Traefik TLS, .env.example

**Resume hint:** Phase 3 Plan 1 complete (commit 242a422). frontend/Dockerfile: node:22-slim builder → nginx:alpine runtime. nginx.conf: SPA fallback, 1y cache /assets/*, no-cache index.html. .dockerignore: excludes node_modules/dist/.env/.git/.planning/tests.

---

*Last updated: 2026-04-24 after Phase 3 Plan 1 completion*
