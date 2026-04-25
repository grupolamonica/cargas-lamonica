#!/usr/bin/env bash
# configure-prometheus-traefik.sh
# Adiciona scrape target do Traefik ao Prometheus no VPS
# Executar UMA VEZ no VPS após deploy das alterações do Traefik
# Uso: bash scripts/configure-prometheus-traefik.sh
set -euo pipefail

echo "[prometheus-traefik] Localizando configuração do Prometheus..."

# Tentar localizar o arquivo prometheus.yml via docker inspect
PROM_CONFIG=""
if docker inspect prometheus > /dev/null 2>&1; then
  # Tentar extrair o bind mount do arquivo de configuração
  PROM_CONFIG=$(docker inspect prometheus --format '{{range .Mounts}}{{if eq .Destination "/etc/prometheus/prometheus.yml"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
fi

# Fallback: buscar em /opt/platform/
if [ -z "$PROM_CONFIG" ]; then
  PROM_CONFIG=$(find /opt/platform -name "prometheus.yml" 2>/dev/null | head -1 || true)
fi

if [ -z "$PROM_CONFIG" ]; then
  echo "[prometheus-traefik] ERROR: prometheus.yml não encontrado automaticamente."
  echo "[prometheus-traefik] Localizar manualmente e adicionar o seguinte bloco em scrape_configs:"
  echo ""
  echo "  - job_name: 'traefik'"
  echo "    static_configs:"
  echo "      - targets: ['traefik:8080']"
  echo ""
  echo "Depois reiniciar o Prometheus: docker compose -f /opt/platform/docker-compose.yml restart prometheus"
  exit 1
fi

echo "[prometheus-traefik] Encontrado: $PROM_CONFIG"

# Verificar se o target já existe
if grep -q "job_name: 'traefik'" "$PROM_CONFIG" 2>/dev/null; then
  echo "[prometheus-traefik] Target traefik já configurado. Nenhuma alteração necessária."
  exit 0
fi

# Verificar permissão de escrita antes de modificar
if [ ! -w "$PROM_CONFIG" ]; then
  echo "[prometheus-traefik] ERROR: Sem permissão de escrita em $PROM_CONFIG (provavelmente root-owned)"
  echo "[prometheus-traefik] Adicionar manualmente o seguinte bloco ao $PROM_CONFIG e reiniciar Prometheus:"
  echo ""
  echo "  - job_name: 'traefik'"
  echo "    static_configs:"
  echo "      - targets: ['traefik:8080']"
  echo ""
  echo "Depois: docker kill --signal=SIGHUP prometheus"
  exit 1
fi

# Adicionar scrape target do Traefik
cat >> "$PROM_CONFIG" << 'SCRAPE_EOF'

    # Traefik metrics — adicionado por configure-prometheus-traefik.sh
      - job_name: 'traefik'
        static_configs:
          - targets: ['traefik:8080']
    SCRAPE_EOF

echo "[prometheus-traefik] Scrape target adicionado a $PROM_CONFIG"
echo "[prometheus-traefik] Reiniciando Prometheus para aplicar configuração..."

# Tentar hot-reload via SIGHUP (preferível ao restart)
docker kill --signal=SIGHUP prometheus 2>/dev/null \
  || docker restart prometheus 2>/dev/null \
  || echo "[prometheus-traefik] WARN: não foi possível reiniciar Prometheus automaticamente — faça manualmente."

echo "[prometheus-traefik] Concluído. Verificar em Prometheus UI -> Status -> Targets: job traefik deve aparecer."
