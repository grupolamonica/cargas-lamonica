#!/usr/bin/env bash
# scripts/smoke-test.sh
# Post-deploy smoke tests for Lamonica Cargas.
# Usage: bash scripts/smoke-test.sh [BASE_URL]
# Example: bash scripts/smoke-test.sh http://76.13.169.177
#
# Exits 0 = all checks passed
# Exits 1 = one or more checks failed (triggers CI job failure + rollback instructions)

set -euo pipefail

BASE_URL="${1:-http://76.13.169.177}"
FAILURES=0
TOTAL=0

check() {
  local label="$1"
  local url="$2"
  local expected_status="$3"
  TOTAL=$((TOTAL + 1))

  local actual_status
  actual_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${url}" 2>/dev/null) || actual_status="000"

  if [ "${actual_status}" = "${expected_status}" ]; then
    echo "  PASS  [${actual_status}] ${label}"
  else
    echo "  FAIL  [${actual_status} != ${expected_status}] ${label} — URL: ${url}"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "================================================"
echo "Lamonica Cargas — Smoke Tests"
echo "Base URL: ${BASE_URL}"
echo "================================================"

# ── Health check (must be 200 — proves backend is up and pg/supabase reachable) ──
check "GET /health" "${BASE_URL}/health" "200"

# ── Auth boundary checks (expect 401 — proves routing + auth middleware active) ──
# Driver endpoints
check "GET /api/drivers/me (auth boundary)" "${BASE_URL}/api/drivers/me" "401"

# Operator dashboard endpoints
check "GET /api/operator/dashboard (auth boundary)" "${BASE_URL}/api/operator/dashboard" "401"
check "GET /api/operator/motoristas (auth boundary)" "${BASE_URL}/api/operator/motoristas" "401"
check "GET /api/operator/cargas (auth boundary)" "${BASE_URL}/api/operator/cargas" "401"
check "GET /api/operator/clientes (auth boundary)" "${BASE_URL}/api/operator/clientes" "401"
check "GET /api/operator/leads (auth boundary)" "${BASE_URL}/api/operator/leads" "401"
check "GET /api/operator/routes (auth boundary)" "${BASE_URL}/api/operator/routes" "401"
check "GET /api/operator/audit-logs (auth boundary)" "${BASE_URL}/api/operator/audit-logs" "401"

# Load claims (operator-protected)
check "GET /api/load-claims/maintenance (auth boundary)" "${BASE_URL}/api/load-claims/maintenance" "401"

echo "================================================"
echo "Results: $((TOTAL - FAILURES))/${TOTAL} passed"

if [ "${FAILURES}" -gt 0 ]; then
  echo ""
  echo "SMOKE TESTS FAILED — ${FAILURES} check(s) failed."
  echo ""
  echo "To rollback: trigger the 'Rollback' workflow in GitHub Actions"
  echo "with the previous SHA, or manually on VPS:"
  echo "  cd /opt/apps/lamonica"
  echo "  docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile production up -d"
  echo "(ensure docker-compose.deploy.yml points to the previous SHA tag)"
  echo "================================================"
  exit 1
fi

echo ""
echo "All smoke tests passed."
echo "================================================"
exit 0
