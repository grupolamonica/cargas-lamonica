#!/usr/bin/env bash
# backup-lamonica.sh — Backup de dados críticos da aplicação Lamonica
# Executa como: antonio-magalhaes (sem sudo necessário)
# Destino: /opt/backups/
# Uso: bash scripts/backup-lamonica.sh
set -euo pipefail

BACKUP_DIR="/opt/backups"
APP_DIR="/opt/apps/lamonica"
DATE=$(date +%Y%m%d-%H%M%S)

echo "[backup-lamonica] Iniciando backup — $DATE"

# Garantir diretório de destino
mkdir -p "$BACKUP_DIR"

# 1. Backup do backend.env (segredos runtime — NÃO está no git)
if [ -f "$APP_DIR/backend.env" ]; then
  cp "$APP_DIR/backend.env" "$BACKUP_DIR/backend.env.$DATE"
  echo "[backup-lamonica] OK: backend.env -> $BACKUP_DIR/backend.env.$DATE"
else
  echo "[backup-lamonica] WARN: $APP_DIR/backend.env não encontrado — pulando"
fi

# 2. Backup do .env (VITE_* para build — NÃO está no git)
if [ -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env" "$BACKUP_DIR/lamonica.env.$DATE"
  echo "[backup-lamonica] OK: .env -> $BACKUP_DIR/lamonica.env.$DATE"
else
  echo "[backup-lamonica] WARN: $APP_DIR/.env não encontrado — pulando"
fi

# 3. Backup do volume Docker traefik_certs (certificados TLS Let's Encrypt)
if docker volume inspect traefik_certs > /dev/null 2>&1; then
  docker run --rm \
    -v traefik_certs:/data \
    -v "$BACKUP_DIR":/backup \
    alpine \
    tar czf "/backup/traefik-certs-$DATE.tar.gz" /data
  echo "[backup-lamonica] OK: traefik_certs -> $BACKUP_DIR/traefik-certs-$DATE.tar.gz"
else
  echo "[backup-lamonica] WARN: volume traefik_certs não encontrado — pulando"
fi

# 4. Limpar backups antigos (manter os últimos 7 dias)
find "$BACKUP_DIR" -name "backend.env.*" -mtime +7 -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "lamonica.env.*" -mtime +7 -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "traefik-certs-*.tar.gz" -mtime +7 -delete 2>/dev/null || true

echo "[backup-lamonica] Backup concluído — $DATE"
