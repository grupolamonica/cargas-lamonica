# Container leve do sync ASPX (aspx_drivers). Só consome cookie + chama a API.
# Playwright/Chromium foram REMOVIDOS: o portal SPX não tem login programático,
# então o login headless nunca funcionou. A renovação de cookie agora é do
# spx-bot (keep-alive) + botão "Atualizar cookies" do painel. Sem Chromium o
# build é rápido e não falha no deploy.
FROM python:3.12-slim

RUN pip install --no-cache-dir requests

WORKDIR /app
COPY asp.py .

CMD ["python", "asp.py", "--service-loop"]
