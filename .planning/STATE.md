---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: 06-03-PLAN.md Task 3 checkpoint:human-verify — aguardando verificação Prometheus no VPS
last_updated: "2026-04-25T10:05:00Z"
progress:
  total_phases: 6
  completed_phases: 5
  total_plans: 13
  completed_plans: 14
  percent: 35
---

# Project State — Lamonica Cargas

**Project:** Lamonica Cargas (LMC)
**Milestone:** v1-refactor-arch-docker-vps
**Last updated:** 2026-04-25 — Completed quick task 260425-a1b: LH fixo + vigência card

## Project Reference

**Core value:** Independência de infraestrutura e clareza arquitetural — deploy controlado em VPS próprio (substitui Vercel), módulos desacoplados (front/back evoluem separadamente), pipeline CI/CD reprodutível.

**Current focus:** Refactor estrutural brownfield. Preserva 100% da lógica de negócio e integrações. Não é reescrita.

**Type:** Brownfield refactor (estrutura + runtime + DevOps)
**Granularity:** coarse (5 phases)
**Parallelization:** sequential
**Sub-repos:** `lan-a-cargas-main` (REMOVED — cleanup complete)

## Current Position

**Phase:** 6 — In progress
**Plan:** 2/4 executed
**Status:** Phase 6 executing — 06-01 (GitHub Actions secrets), 06-02 (backup-lamonica.sh + README backup), 06-03 tasks 1+2 done. 06-03 Task 3 (checkpoint:human-verify Prometheus target) pendente. 06-04 (enable-ssl.sh) pending.
**Progress:** [███░░░░░░░] 35% complete

```
Phase 1: Structural Split + Clean Architecture   [x] COMPLETE (Plans 1+2+3+4 done)
Phase 2: Backend Runtime Migration               [x] COMPLETE (Plans 1+2 done)
Phase 3: Dockerization                           [x] COMPLETE (Plans 1+2+3 done)
Phase 4: Communication & Env Configuration       [x] COMPLETE (Plan 1 done)
Phase 5: CI/CD + VPS Deploy + Cleanup            [x] COMPLETE (Plans 1+2+3 done)
Phase 6: VPS Server Hardening and CI/CD Config   [ ] IN PROGRESS (2/4 done)
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
| 3 | 3 | ~2min | 2/2 | 3 created | 2026-04-24 |
| 05-cicd-vps-deploy | 05-01 | ~5min | 2/2 | 2 created | 2026-04-24 |
| 05-cicd-vps-deploy | 05-02 | ~1min | 1/1 | 1 created | 2026-04-24 |
| Phase 05-cicd-vps-deploy P05-03 | 2min | 2 tasks | 4 files |
| 06-vps-server-hardening | 06-02 | ~5min | 2/2 | 2 created/modified | 2026-04-25 |
| 06-vps-server-hardening | 06-03 | ~8min | 2/3 (checkpoint) | 1 created, 1 modified | 2026-04-25 |

## Accumulated Context

### Key Decisions

| Decision | Context | Status |
|----------|---------|--------|
| Sair da Vercel para VPS | VPS dá controle total, elimina cold starts, resolve H-01 (state mismatch), reduz custo recorrente | Approved (in PROJECT.md) |
| Clean architecture (domain/application/infrastructure/interface) | Separar regras de negócio de integrações externas; facilita testes e evolução | Approved |
| Docker Compose (não k8s) | Escala atual não justifica k8s; compose é simples de operar em VPS single-host | Approved |
| GHCR como registry | Integração nativa com GitHub Actions, free para repos privados sob org | Approved |
| GITHUB_TOKEN for GHCR (no extra PAT) | packages:write permission per-job; no GHCR_TOKEN secret needed | Approved (Phase 5 Plan 1) |
| SHA tag format: sha-<full-sha> | docker/metadata-action type=sha,format=long; rollback uses exact 40-char sha prefix | Approved (Phase 5 Plan 1) |
| docker-compose.deploy.yml runtime override | VPS-side file generated per deploy/rollback; pins exact SHA; never committed to repo | Approved (Phase 5 Plan 1) |
| Traefik como reverse proxy | TLS automático (Let's Encrypt), descoberta por labels, zero-config para novos containers | Approved (Phase 3 Plan 3) |
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
| Traefik HTTP→HTTPS redirect no entryPoint (não por router) | v3 clean pattern — redirect configurado uma vez, não replicado em cada router label | Approved (Phase 3 Plan 3) |
| reverse-proxy em production profile no override | Plain docker compose up skips Traefik; vite proxy (/api → localhost:3001) serve dev | Approved (Phase 3 Plan 3) |
| ACME email placeholder (admin@lamonica.example.com) | YAML não expande variáveis shell — placeholder estático; Phase 4 substitui pelo real | Approved (Phase 3 Plan 3) |
| frontend builder stage target no override | Reutiliza Dockerfile existente sem Dockerfile.dev separado; vite disponível na imagem builder | Approved (Phase 3 Plan 3) |
| VITE_* ARGs com default empty string no Dockerfile | Backward-compat com dev (empty = /api/* relativo); sem segredo no frontend image | Approved (Phase 3 Plan 1) |
| nginx:alpine runtime (não node) | Footprint mínimo <200MB; serve static assets eficientemente | Approved (Phase 3 Plan 1) |
| Smoke test: 401 for auth-boundary endpoints | 401 proves Traefik routing + Express auth middleware active; avoids needing real creds in CI | Approved (Phase 5 Plan 2) |
| smoke-test.sh BASE_URL as $1 | Same script usable in CI (secrets.VPS_HOST) and locally against dev VPS | Approved (Phase 5 Plan 2) |
| api.insecure=false no Traefik | Dashboard protegido via router Docker label + BasicAuth middleware; não exposto em 8080 sem auth | Approved (Phase 6 Plan 3) |
| metrics.prometheus sem entrypoint separado | Endpoint em traefik:8080/metrics (porta internal traefik) — Prometheus scrape é interno, não exposto | Approved (Phase 6 Plan 3) |

### Decisions Pending

None.

### Roadmap Evolution

- Phase 6 added: VPS Server Hardening and CI/CD Configuration (2026-04-25) — GitHub Actions secrets, backups, Traefik métricas + enable-ssl.sh migrado

### Active Todos

- Plan + Execute Phase 6 (VPS Server Hardening) — contexto capturado no relatório VPS 2026-04-25

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260425-a1b | Fix sheet_lh permanência + vigência card motorista alocado | 2026-04-25 | 48e9ad6 | [260425-a1b-lh-fixo-vigencia-card](./quick/260425-a1b-lh-fixo-vigencia-card/) |

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

**Stopped at:** 06-03-PLAN.md Task 3 checkpoint:human-verify — Tasks 1+2 completas (traefik.yml + configure-prometheus-traefik.sh). Aguardando execução do script no VPS e confirmação do Prometheus target "traefik".

**Next action:** Após verificação no VPS, continuar 06-03 Task 3 e depois executar 06-04-PLAN.md (enable-ssl.sh).

**Resume hint:** Phase 6 in progress (2.5/4 done). 06-03 tasks 1+2 commitadas (fff521b, 38520d2). Task 3 = checkpoint humano: executar script VPS + verificar Prometheus target.

---

*Last updated: 2026-04-24 after Phase 5 Plan 3 completion — milestone complete*
