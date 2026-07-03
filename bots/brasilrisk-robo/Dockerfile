# Robô BRK (Brasil Risk) — servidor REST de consulta + refresher/keepalive.
#
# O servidor de consulta (server.js) é Node puro. O Chromium + Xvfb só são usados
# pelo bootstrap/renovação do cf_clearance (`refresh_cookies_brk_pw.js login`),
# rodado sob demanda via `docker exec` (ver README). A sessão (cookie.txt) e o
# perfil do Chromium persistem num volume montado em ./backend e ./pw_profile.
FROM node:22-bookworm-slim

# Chromium do sistema (puppeteer usa o binário via PUPPETEER_EXECUTABLE_PATH) +
# Xvfb (display virtual p/ o login headed que resolve o Turnstile) + curl (healthcheck).
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb curl ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

ENV BRK_SIDECAR_HOST=0.0.0.0 \
    BRK_SIDECAR_PORT=8767
EXPOSE 8767

HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fs http://localhost:8767/health || exit 1

# Serviço padrão = servidor REST de consulta (Node puro, sem navegador).
CMD ["node", "server.js"]
