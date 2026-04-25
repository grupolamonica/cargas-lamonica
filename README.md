# Lamonica Cargas

Logistics platform for cargo operations, driver portal, and operator dashboard.

## Architecture

```
GitHub (main branch)
    │ push
    ▼
GitHub Actions (deploy.yml)
    ├── test (vitest + lint)
    ├── build-frontend ──► ghcr.io/grupolamonica/lamonica-frontend:<sha>
    ├── build-backend  ──► ghcr.io/grupolamonica/lamonica-backend:<sha>
    └── deploy-vps (SSH)
            │
            ▼
VPS 76.13.169.177
├── Traefik v3 (:80/:443, Let's Encrypt)
├── frontend (nginx:alpine, port 80 internal)
└── backend  (node:22-slim, port 3001 internal)
            │
            ▼
Supabase (PostgreSQL + Auth, managed external)
```

**Stack:**
- Frontend: React 18 + Vite 6 + TypeScript 5.8 + TanStack Query v5 + shadcn/ui + Tailwind 3
- Backend: Node.js 22 ESM + Express v4 + pg 8 + @supabase/supabase-js + zod 3
- Database: PostgreSQL via Supabase (managed, external)
- Auth: Supabase Auth dual (operator: `lamonica-operator-auth` / driver: `lamonica-driver-auth`)
- Registry: `ghcr.io/grupolamonica/lamonica-{frontend,backend}`
- Reverse proxy: Traefik v3 (TLS via Let's Encrypt ACME httpChallenge)

## Local Development

```bash
# Prerequisites: Docker + Docker Compose

# Copy and fill env files
cp backend/.env.example backend/.env
# Fill SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in backend/.env

# Start (uses docker-compose.override.yml automatically — vite dev + node --watch)
docker compose up

# Frontend: http://localhost:8080  (vite dev, HMR)
# Backend:  http://localhost:3001  (node --watch)

# Run tests
cd frontend && npm test
cd backend  && npm test
```

## Required GitHub Secrets

Configure these in GitHub repo **Settings → Secrets and variables → Actions**, under the `production` environment.

| Secret | Description | Where to find |
|--------|-------------|---------------|
| `VPS_SSH_KEY` | Private SSH key for VPS access | `cat ~/.ssh/id_ed25519` — paste entire file contents |
| `VPS_HOST` | VPS IP or hostname | `76.13.169.177` |
| `VPS_USER` | SSH username on VPS | e.g. `ubuntu` |
| `VITE_SUPABASE_URL` | Supabase project URL | Supabase Dashboard → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon public key | Supabase Dashboard → Project Settings → API → anon public |
| `VITE_API_BASE_URL` | API base URL prefix | Leave empty (`""`) for same-origin `/api` routing |

> **Note:** `GITHUB_TOKEN` is provided automatically by GitHub Actions — no manual secret needed for GHCR access.

## VPS First-Time Setup

Complete these steps on the VPS **before** running the pipeline for the first time.

```bash
# 1. Stop and disable central Nginx — Traefik takes over ports 80/443
sudo systemctl stop nginx
sudo systemctl disable nginx
# Note: Any other apps on the VPS using central Nginx must be moved to different ports
# or Dockerized separately. Traefik owns 80/443 for this application.

# 2. Ensure UFW allows 80, 443, and SSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp

# 3. Create app directory
sudo mkdir -p /opt/apps/lamonica
sudo chown $USER:$USER /opt/apps/lamonica

# 4. Clone repo
cd /opt/apps/lamonica
git clone https://github.com/grupolamonica/cargas-lamonica.git .

# 5. Create backend.env from example (fill in real values)
cp backend/.env.example backend.env
nano backend.env
# Required: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# Set:      ALLOWED_ORIGINS=https://yourdomain.com
# Set:      TRUST_PROXY_HEADERS=true

# 6. Set DOMAIN for Traefik routing + TLS certificate
echo 'DOMAIN=yourdomain.com' >> /opt/apps/lamonica/.env
# Or: export DOMAIN=yourdomain.com  (must be available when docker compose runs)
```

> **VPS requirements:** Docker and Docker Compose must be installed. The SSH user must be in the `docker` group (no sudo needed for docker commands).

## Deploying

```bash
# Automatic: push to main branch triggers the full pipeline
git push origin main

# Monitor at: https://github.com/grupolamonica/cargas-lamonica/actions

# Pipeline stages:
#   1. test         — npm ci + lint + vitest (frontend + backend)
#   2. build-frontend — docker build → push ghcr.io/.../lamonica-frontend:<sha>
#   3. build-backend  — docker build → push ghcr.io/.../lamonica-backend:<sha>
#   4. deploy-vps     — SSH: docker compose pull + up -d + smoke tests

# Manual deploy (on VPS directly):
cd /opt/apps/lamonica
git pull
docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile production up -d
```

## Rollback

```bash
# Option A: GitHub Actions workflow_dispatch (preferred)
# 1. Go to GitHub → Actions → "Rollback" workflow → Run workflow
# 2. Enter the full git SHA to roll back to (find in previous Actions run history)
# 3. Type "rollback" in the confirm field
#
# The workflow will:
#   - Validate the SHA tag exists in GHCR
#   - SSH to VPS, pull the old images, restart services
#   - Run smoke tests to confirm the rollback is healthy

# Option B: Manual SSH (emergency)
ssh user@76.13.169.177
cd /opt/apps/lamonica

# Write docker-compose.deploy.yml to point to the previous SHA:
cat > docker-compose.deploy.yml << EOF
services:
  frontend:
    image: ghcr.io/grupolamonica/lamonica-frontend:sha-<PREVIOUS_SHA>
  backend:
    image: ghcr.io/grupolamonica/lamonica-backend:sha-<PREVIOUS_SHA>
EOF

docker compose -f docker-compose.yml -f docker-compose.deploy.yml --profile production up -d
bash scripts/smoke-test.sh http://76.13.169.177
```

> **Finding the SHA:** In GitHub Actions, each run shows the full commit SHA. Use the SHA from the last known-good deploy run.

## Backup de Dados Críticos

O script `scripts/backup-lamonica.sh` faz backup de:
- `/opt/apps/lamonica/backend.env` — segredos runtime (não versionado)
- `/opt/apps/lamonica/.env` — variáveis de build Supabase (não versionado)
- Volume Docker `traefik_certs` — certificados TLS Let's Encrypt

Backups ficam em `/opt/backups/` com timestamp. Retenção: 7 dias.

**Executar manualmente:**
```bash
# No VPS, como antonio-magalhaes:
cd /opt/apps/lamonica
bash scripts/backup-lamonica.sh
```

**Agendar via cron (recomendado — diário às 03:00):**
```bash
crontab -e
# Adicionar:
0 3 * * * cd /opt/apps/lamonica && bash scripts/backup-lamonica.sh >> /opt/backups/backup.log 2>&1
```

## Environment Variables

```
backend/.env.example  — full documentation of all backend runtime vars
frontend/.env.example — build-time VITE_* vars (baked into frontend image at build time)

Production runtime vars are in `backend.env` (gitignored) at workspace root.
VITE_* vars are injected as --build-arg into the frontend Docker image by GitHub Actions secrets.
DOMAIN must be set in /opt/apps/lamonica/.env on the VPS for Traefik to route and issue TLS certs.
```

## Smoke Tests

```bash
# Runs automatically as the last step of each deploy/rollback in CI.
# Run manually against the VPS:
bash scripts/smoke-test.sh http://76.13.169.177

# Tests /health (200) + 9 auth-boundary endpoints (401).
# Non-zero exit = something is broken — check container logs:
docker compose -f docker-compose.yml -f docker-compose.deploy.yml logs --tail=50
```
