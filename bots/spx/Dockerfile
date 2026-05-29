# bots/spx/Dockerfile — sidecar FastAPI (porta 8766)
# Cliente HTTP puro pra portal SPX (Shopee Express). Cookies SSO vêm da
# tabela aspx_credentials no Supabase (renovação automática via container
# aspx-renewal que roda Playwright a cada 4 dias).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY run.py ./
COPY backend ./backend

RUN useradd --create-home --shell /bin/bash bot \
 && chown -R bot:bot /app
USER bot

EXPOSE 8766
ENV SPX_SIDECAR_HOST=0.0.0.0 SPX_SIDECAR_PORT=8766

CMD ["python", "run.py"]
