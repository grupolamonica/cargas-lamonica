# bots/unificada/Dockerfile — sidecar FastAPI (porta 8001)
# Gera Risk Assessment Document (PDF) via ReportLab a partir da API Angellira.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# curl pro HEALTHCHECK; build-essential + libxml2/libxslt-dev sao necessarios
# para compilar lxml (dep transitiva de svglib) em python:3.12-slim.
# Removemos build-essential apos o pip install pra manter imagem enxuta.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates \
      build-essential libxml2-dev libxslt1-dev \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt \
 && apt-get purge -y build-essential libxml2-dev libxslt1-dev \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY run.py ./
COPY backend ./backend
COPY static ./static

RUN useradd --create-home --shell /bin/bash bot \
 && chown -R bot:bot /app
USER bot

EXPOSE 8001
ENV UNIFICADA_HOST=0.0.0.0 UNIFICADA_PORT=8001

CMD ["python", "run.py"]
