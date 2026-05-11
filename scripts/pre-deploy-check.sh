#!/usr/bin/env bash
# Pre-deploy check — Lamonica Cargas
# Roda todas as verificacoes locais antes de mergeear / fazer deploy.
# Uso: bash scripts/pre-deploy-check.sh
# Sai com exit 1 se algum gate falhar.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

FAILED=0

bold "=== Lamonica Pre-deploy Check ==="
echo ""

# 1. Branch state
bold "[1/8] Branch state"
git ls-files -m > /tmp/lmn-modified.txt
MODIFIED_COUNT=$(wc -l < /tmp/lmn-modified.txt)
if [ "$MODIFIED_COUNT" -gt 0 ]; then
  yellow "  $MODIFIED_COUNT arquivo(s) modificado(s) sem commit:"
  cat /tmp/lmn-modified.txt | sed 's/^/    /'
fi
UNTRACKED=$(git status --short | grep "^??" | wc -l)
if [ "$UNTRACKED" -gt 0 ]; then
  yellow "  $UNTRACKED arquivo(s) untracked"
fi
echo ""

# 2. Schema refs (colunas removidas)
bold "[2/8] Schema refs (colunas removidas em migrations recentes)"
DEAD_COLS_PATTERN='cliente\.(tipo_veiculo|peso|antt|rastreamento|valor_frete)\b|clientes\.(tipo_veiculo|peso|antt|rastreamento|valor_frete)\b'
DEAD_HITS=$(grep -rEn "$DEAD_COLS_PATTERN" frontend/src backend/src 2>/dev/null \
  | grep -v "exige_antt\|exige_rastreamento" \
  | grep -v ".test." \
  | grep -v "src/scripts/" || true)
if [ -n "$DEAD_HITS" ]; then
  red "  ✗ Refs a colunas removidas encontradas:"
  echo "$DEAD_HITS" | head -10 | sed 's/^/    /'
  FAILED=1
else
  green "  ✓ Sem refs a colunas removidas"
fi
echo ""

# 3. console.* sem DEV gate
bold "[3/8] console.* sem DEV gate em frontend"
UNGATED=$(grep -rEn 'console\.(log|debug|warn|error)' frontend/src --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v 'import.meta.env.DEV' \
  | grep -v 'ErrorBoundary' || true)
if [ -n "$UNGATED" ]; then
  yellow "  ⚠  console.* sem DEV gate (revisar):"
  echo "$UNGATED" | head -5 | sed 's/^/    /'
fi
echo ""

# 4. Frontend build
bold "[4/8] Frontend build"
if (cd frontend && npm run build > /tmp/lmn-build.log 2>&1); then
  green "  ✓ Build OK"
else
  red "  ✗ Build FAILED — ver /tmp/lmn-build.log"
  tail -20 /tmp/lmn-build.log | sed 's/^/    /'
  FAILED=1
fi
echo ""

# 5. Frontend lint
bold "[5/8] Frontend lint"
if (cd frontend && npm run lint > /tmp/lmn-lint.log 2>&1); then
  green "  ✓ Lint OK"
else
  ERRORS=$(grep -c "error" /tmp/lmn-lint.log || true)
  if [ "$ERRORS" -gt 0 ]; then
    red "  ✗ $ERRORS erro(s) de lint"
    tail -10 /tmp/lmn-lint.log | sed 's/^/    /'
    FAILED=1
  else
    yellow "  ⚠  Lint com warnings (aceitavel)"
  fi
fi
echo ""

# 6. Frontend tests
bold "[6/8] Frontend tests"
if (cd frontend && npm test > /tmp/lmn-fe-test.log 2>&1); then
  green "  ✓ Tests OK"
else
  red "  ✗ Tests FAILED"
  tail -15 /tmp/lmn-fe-test.log | sed 's/^/    /'
  FAILED=1
fi
echo ""

# 7. Backend handler tests (subset confiavel)
bold "[7/8] Backend handler tests"
if (cd backend && npx vitest run src/interface/http/ > /tmp/lmn-be-test.log 2>&1); then
  green "  ✓ Handler tests OK"
else
  red "  ✗ Handler tests FAILED"
  tail -15 /tmp/lmn-be-test.log | sed 's/^/    /'
  FAILED=1
fi
echo ""

# 8. Migrations dispersas
bold "[8/8] Migrations dispersas"
ROOT_MIGRATIONS=$(ls -1 supabase/migrations 2>/dev/null | wc -l)
BACKEND_MIGRATIONS=$(ls -1 backend/supabase/migrations 2>/dev/null | wc -l)
if [ "$ROOT_MIGRATIONS" -gt 0 ]; then
  yellow "  ⚠  $ROOT_MIGRATIONS migration(s) em supabase/ root (canonical = backend/supabase/)"
  ls -1 supabase/migrations | sed 's/^/    /'
fi
echo ""

# Final
if [ "$FAILED" -eq 0 ]; then
  green "=== ✓ Tudo verde — pode mergeear ==="
  exit 0
else
  red "=== ✗ Falhou em algum gate — NAO mergeie ==="
  exit 1
fi
