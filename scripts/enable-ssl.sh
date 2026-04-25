#!/usr/bin/env bash
# enable-ssl.sh — Ativa TLS automático (Let's Encrypt) via Traefik para um domínio
#
# SUBSTITUI: /opt/scripts/enable-ssl.sh (nginx-based, root-owned — não pode ser modificado)
# LOCALIZAÇÃO: /opt/apps/lamonica/scripts/enable-ssl.sh (propriedade antonio-magalhaes)
#
# Pré-requisitos:
#   - DNS do DOMAIN apontando para 76.13.169.177
#   - Traefik já rodando em /opt/platform/traefik/
#   - docker-compose.domain.yml presente em /opt/apps/lamonica/
#
# Uso:
#   bash scripts/enable-ssl.sh meudominio.com
#
set -euo pipefail

# ── Validação de argumento ────────────────────────────────────────────────────
if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Uso: $0 <DOMAIN>"
  echo "Exemplo: $0 cargas.lamonica.com.br"
  exit 1
fi

DOMAIN="$1"
TRAEFIK_DIR="/opt/platform/traefik"
APP_DIR="/opt/apps/lamonica"
TRAEFIK_YML="$TRAEFIK_DIR/traefik.yml"
BACKEND_ENV="$APP_DIR/backend.env"

echo "[enable-ssl] Ativando TLS para domínio: $DOMAIN"

# ── Verificar DNS antes de prosseguir ─────────────────────────────────────────
echo "[enable-ssl] Verificando DNS..."
VPS_IP="76.13.169.177"
RESOLVED_IP=$(dig +short "$DOMAIN" | tail -1 || true)
if [ "$RESOLVED_IP" != "$VPS_IP" ]; then
  echo "[enable-ssl] WARN: DNS de $DOMAIN resolve para '$RESOLVED_IP' (esperado: $VPS_IP)"
  echo "[enable-ssl] Continuar mesmo assim? (s/N)"
  read -r CONFIRM
  if [ "${CONFIRM,,}" != "s" ]; then
    echo "[enable-ssl] Abortado. Configure o DNS antes de executar novamente."
    exit 1
  fi
else
  echo "[enable-ssl] DNS OK: $DOMAIN -> $VPS_IP"
fi

# ── Passo 1: Descomentar certificatesResolvers no traefik.yml ────────────────
echo "[enable-ssl] Habilitando certificatesResolvers no $TRAEFIK_YML..."

if [ ! -f "$TRAEFIK_YML" ]; then
  echo "[enable-ssl] ERROR: $TRAEFIK_YML não encontrado"
  exit 1
fi

# Backup antes de modificar
cp "$TRAEFIK_YML" "$TRAEFIK_YML.bak.$(date +%Y%m%d-%H%M%S)"

# Descomentar bloco certificatesResolvers (remove # no início de linhas do bloco)
# O padrão assume que o bloco está comentado com "# " (hash + espaço)
sed -i '/^# certificatesResolvers:/,/^[^#]/ {
  /^# /s/^# //
}' "$TRAEFIK_YML"

# Alternativa mais simples se o sed acima não funcionar na distro do VPS:
# python3 -c "
# import re, sys
# text = open('$TRAEFIK_YML').read()
# text = re.sub(r'^# (certificatesResolvers.*)', r'\1', text, flags=re.MULTILINE)
# text = re.sub(r'^#   (.*acme.*|.*email.*|.*storage.*|.*tlsChallenge.*|.*httpChallenge.*)', r'  \1', text, flags=re.MULTILINE)
# open('$TRAEFIK_YML', 'w').write(text)
# "

echo "[enable-ssl] traefik.yml atualizado"

# ── Passo 2: Atualizar ALLOWED_ORIGINS no backend.env ────────────────────────
echo "[enable-ssl] Atualizando ALLOWED_ORIGINS em $BACKEND_ENV..."

if [ -f "$BACKEND_ENV" ]; then
  # Substituir linha ALLOWED_ORIGINS existente
  if grep -q "^ALLOWED_ORIGINS=" "$BACKEND_ENV"; then
    sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://$DOMAIN|" "$BACKEND_ENV"
  else
    echo "ALLOWED_ORIGINS=https://$DOMAIN" >> "$BACKEND_ENV"
  fi
  echo "[enable-ssl] ALLOWED_ORIGINS=https://$DOMAIN configurado"
else
  echo "[enable-ssl] WARN: $BACKEND_ENV não encontrado — criar manualmente com ALLOWED_ORIGINS=https://$DOMAIN"
fi

# ── Passo 3: Reiniciar Traefik para aplicar nova configuração ────────────────
echo "[enable-ssl] Reiniciando Traefik..."
cd "$TRAEFIK_DIR"
docker compose up -d --force-recreate
echo "[enable-ssl] Traefik reiniciado"

# ── Passo 4: Reiniciar backend com overlay de domínio ────────────────────────
echo "[enable-ssl] Reiniciando backend com docker-compose.domain.yml..."
cd "$APP_DIR"

if [ ! -f "docker-compose.domain.yml" ]; then
  echo "[enable-ssl] WARN: docker-compose.domain.yml não encontrado em $APP_DIR"
  echo "[enable-ssl] Reiniciando apenas com overlays padrão..."
  docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
else
  docker compose -f docker-compose.yml -f docker-compose.vps.yml -f docker-compose.domain.yml up -d
fi

echo "[enable-ssl] Backend reiniciado"

# ── Passo 5: Aguardar e verificar certificado ─────────────────────────────────
echo "[enable-ssl] Aguardando Traefik obter certificado TLS (timeout: 120s)..."
for i in $(seq 1 12); do
  sleep 10
  CERT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://$DOMAIN/" 2>/dev/null || echo "000")
  if [ "$CERT_STATUS" != "000" ]; then
    echo "[enable-ssl] HTTPS respondeu com HTTP $CERT_STATUS após $((i*10))s"
    break
  fi
  echo "[enable-ssl] Aguardando... $((i*10))s"
done

echo ""
echo "[enable-ssl] Concluído. Verificações finais:"
echo "  curl -I https://$DOMAIN/"
echo "  curl -I http://$DOMAIN/  # deve redirecionar para HTTPS (301)"
echo ""
echo "[enable-ssl] Se o certificado não chegar em 2 minutos, verificar:"
echo "  docker logs traefik 2>&1 | grep -i 'acme\|certificate\|error'"
