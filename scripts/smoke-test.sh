#!/usr/bin/env bash
# scripts/smoke-test.sh
# Post-deploy smoke tests for Lamonica Cargas.
# Runs on the VPS via SSH — hits the backend container directly on its internal
# port (bypassing Traefik) so HTTPS redirects or missing websecure entrypoints
# don't affect results.
#
# Exits 0 = all checks passed
# Exits 1 = one or more checks failed (triggers CI job failure + rollback instructions)

set -euo pipefail

BACKEND_CONTAINER="${BACKEND_CONTAINER:-lamonica-backend-1}"
BACKEND_PORT="${BACKEND_PORT:-3001}"
FAILURES=0
TOTAL=0

# Resolve backend container's internal IP in the Docker network
BACKEND_IP=$(docker inspect "${BACKEND_CONTAINER}" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | head -1)

if [ -z "${BACKEND_IP}" ]; then
  echo "ERROR: Could not resolve IP for container ${BACKEND_CONTAINER}"
  echo "Is the container running? Run: docker ps | grep lamonica-backend"
  exit 1
fi

BACKEND_URL="http://${BACKEND_IP}:${BACKEND_PORT}"

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
echo "Backend: ${BACKEND_CONTAINER} @ ${BACKEND_URL}"
echo "================================================"

# ── Health check (must be 200 — proves backend is up and pg/supabase reachable) ──
check "GET /health" "${BACKEND_URL}/health" "200"

# ── Auth boundary checks (expect 401 — proves auth middleware active) ──
# Driver endpoints
check "GET /api/drivers/me (auth boundary)" "${BACKEND_URL}/api/drivers/me" "401"

# Operator dashboard endpoints
check "GET /api/operator/dashboard (auth boundary)" "${BACKEND_URL}/api/operator/dashboard" "401"
check "GET /api/operator/motoristas (auth boundary)" "${BACKEND_URL}/api/operator/motoristas" "401"
check "GET /api/operator/cargas (auth boundary)" "${BACKEND_URL}/api/operator/cargas" "401"
check "GET /api/operator/clientes (auth boundary)" "${BACKEND_URL}/api/operator/clientes" "401"
check "GET /api/operator/leads (auth boundary)" "${BACKEND_URL}/api/operator/leads" "401"
check "GET /api/operator/routes (auth boundary)" "${BACKEND_URL}/api/operator/routes" "401"
check "GET /api/operator/audit-logs (auth boundary)" "${BACKEND_URL}/api/operator/audit-logs" "401"

# Load claims (operator-protected)
check "GET /api/load-claims/maintenance (auth boundary)" "${BACKEND_URL}/api/load-claims/maintenance" "401"

echo "================================================"
echo "Results: $((TOTAL - FAILURES))/${TOTAL} passed"

if [ "${FAILURES}" -gt 0 ]; then
  echo ""
  echo "SMOKE TESTS FAILED — ${FAILURES} check(s) failed."
  echo ""
  echo "To rollback: trigger the 'Rollback' workflow in GitHub Actions"
  echo "with the previous SHA, or manually on VPS:"
  echo "  cd /opt/apps/lamonica"
  echo "  docker compose -f docker-compose.yml -f docker-compose.vps.yml -f docker-compose.deploy.yml up -d"
  echo "(ensure docker-compose.deploy.yml points to the previous SHA tag)"
  echo "================================================"
  exit 1
fi

echo ""
echo "All smoke tests passed."
echo "================================================"
exit 0
