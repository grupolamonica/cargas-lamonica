---
phase: 05-cicd-vps-deploy
plan: "02"
subsystem: cicd
tags: [bash, curl, smoke-test, ci-cd, deploy, github-actions]

# Dependency graph
requires:
  - phase: 05-cicd-vps-deploy
    provides: deploy.yml and rollback.yml workflows that call this script post-deploy
provides:
  - scripts/smoke-test.sh — curl-based post-deploy regression gate for ~10 critical endpoints
affects: [05-03-cleanup, github-actions-deploy]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Auth-boundary smoke testing: test protected endpoints for 401, not authenticated flows — proves routing + auth middleware active without needing secrets in CI"
    - "Curl smoke test exit-code gate: non-zero exit fails CI job and prints rollback instructions"

key-files:
  created:
    - scripts/smoke-test.sh
  modified: []

key-decisions:
  - "Test auth-required endpoints for 401, not 200 — a 401 proves Traefik routing + Express auth middleware are both active; a 500 or 000 means something is broken"
  - "BASE_URL as $1 with default fallback — same script usable in CI (secrets.VPS_HOST) and locally"
  - "10 endpoints: /health (200) + 9 auth-boundary endpoints (401) — satisfies D-04 scope limit"

patterns-established:
  - "Smoke test pattern: health endpoint first (proves backend alive), then auth boundaries (proves routing + middleware)"
  - "Rollback instructions printed inline on failure — CI operator sees next step without context-switching"

requirements-completed:
  - CICD-07
  - CLEAN-03

# Metrics
duration: 1min
completed: 2026-04-24
---

# Phase 5 Plan 02: Smoke Test Suite Summary

**Curl-based post-deploy smoke test covering /health (200) and 9 auth-boundary endpoints (401) — callable from CI as `bash scripts/smoke-test.sh http://${{ secrets.VPS_HOST }}`**

## Performance

- **Duration:** ~1 min
- **Started:** 2026-04-24T17:50:52Z
- **Completed:** 2026-04-24T17:51:37Z
- **Tasks:** 1/1
- **Files modified:** 1 created

## Accomplishments

- Created `scripts/smoke-test.sh` — bash smoke test with shebang, set -euo pipefail, and 10 endpoint checks
- Health endpoint tested for HTTP 200 (proves backend running and pg/supabase reachable)
- 9 auth-boundary endpoints tested for HTTP 401 (proves Traefik routing + Express auth middleware active)
- Script exits 1 on any failure and prints human-readable rollback instructions
- File marked executable (chmod +x)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create scripts/smoke-test.sh** - `b8eed8a` (feat)

## Files Created/Modified

- `scripts/smoke-test.sh` — curl smoke test; accepts BASE_URL as $1, tests 10 endpoints, exits non-zero on failure

## Endpoint Coverage

| Endpoint | Expected Status | Rationale |
|----------|----------------|-----------|
| GET /health | 200 | Backend alive + pg/supabase reachable |
| GET /api/driver/loads | 401 | Traefik /api routing + driver auth middleware |
| GET /api/drivers/me | 401 | Driver auth boundary |
| GET /api/operator/dashboard | 401 | Operator auth boundary |
| GET /api/operator/motoristas | 401 | Operator list endpoint |
| GET /api/operator/cargas | 401 | Operator cargas endpoint |
| GET /api/operator/clientes | 401 | Operator clientes endpoint |
| GET /api/operator/rotas | 401 | Operator rotas endpoint |
| GET /api/operator/audit-logs | 401 | Operator audit-logs endpoint |
| GET /api/load-claims/maintenance | 401 | Load claims operator-protected |

## Integration with CI/CD

**deploy.yml** calls `bash scripts/smoke-test.sh http://${{ secrets.VPS_HOST }}` as the final step of the deploy job. Non-zero exit fails the CI job and blocks any downstream steps.

**rollback.yml** calls `bash scripts/smoke-test.sh http://${{ secrets.VPS_HOST }}` after rolling back to a previous SHA tag — verifies the rollback itself is healthy.

**Local use:** `bash scripts/smoke-test.sh http://76.13.169.177` (default BASE_URL is the VPS IP).

## Note on Test Scope

Tests auth boundary (401), not full authenticated flows. Full endpoint parity with authenticated requests is Phase 2 integration tests (vitest). The smoke test purpose is to catch broken routing, crashed containers, or missing env vars before human review — a 401 is sufficient proof that the endpoint path is live and auth middleware is active.

## Decisions Made

- Test protected endpoints for 401, not 200: 401 proves (a) Traefik is routing /api/* to the backend, and (b) the auth middleware is active. A 500 or 000 (connection refused) means something is seriously broken — which is what smoke tests catch.
- BASE_URL as $1 with `${1:-http://76.13.169.177}` default: same script runs in CI with the VPS_HOST secret and locally against the dev VPS.
- Script scope capped at 10 endpoints per D-04 decision — full parity is a Phase 2 concern.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- `scripts/smoke-test.sh` is ready for reference in deploy.yml and rollback.yml (already created in 05-01)
- Phase 5 Plan 03 (README update + Traefik ACME email + Vercel cleanup) is the final plan
- No blockers

---
*Phase: 05-cicd-vps-deploy*
*Completed: 2026-04-24*

## Self-Check: PASSED

- [x] `scripts/smoke-test.sh` exists
- [x] Commit `b8eed8a` exists (`feat(05-02): add curl-based smoke test for ~10 critical endpoints`)
- [x] 10 check() calls confirmed (grep output: 10)
- [x] exit 1 and exit 0 both present
- [x] File is executable
