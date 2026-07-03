# Container do sync ASPX + self-heal da sessão SPX (login headless Playwright).
# O login headless FUNCIONA na VPS (sem captcha no IP do servidor) com os
# seletores corretos do SSO — ver _login_playwright em asp.py. Chromium é
# necessário para esse login/refresh; o perfil persistente fica num volume.
FROM python:3.12-slim

RUN pip install --no-cache-dir requests playwright \
 && playwright install --with-deps chromium

WORKDIR /app
COPY asp.py .

CMD ["python", "asp.py", "--service-loop"]
