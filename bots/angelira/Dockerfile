# bots/angelira/Dockerfile — sidecar FastAPI (porta 8765)
# Cliente HTTP puro pra api.angellira.com.br/profile/* — sem Selenium.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# curl é usado pelo HEALTHCHECK do docker-compose
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY run.py ./
COPY backend ./backend

# Diretorio writable pra anexos temporarios (anexo_storage)
RUN mkdir -p /app/backend/anexos_tmp

# Roda como usuario nao-root
RUN useradd --create-home --shell /bin/bash bot \
 && chown -R bot:bot /app
USER bot

EXPOSE 8765
ENV HOST=0.0.0.0 PORT=8765

CMD ["python", "run.py"]
