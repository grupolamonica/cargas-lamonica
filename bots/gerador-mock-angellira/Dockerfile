# Gerador Mock AngelLira — microservico HTTP (PDF do dossie a partir de JSON).
FROM python:3.13-slim

# libs de sistema p/ Pillow/lxml (svglib) — wheels normalmente bastam,
# mas garantimos os runtimes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo zlib1g libxml2 libxslt1.1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Codigo + assets (nao copia .venv/data/build via .dockerignore)
COPY app.py launcher.py ./
COPY shared/ ./shared/
COPY static/ ./static/

ENV PORT=8000
EXPOSE 8000

# Healthcheck bate no /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.getenv(\"PORT\",\"8000\")}/health', timeout=3)" || exit 1

# Microservico: uvicorn direto (sem abrir navegador). host 0.0.0.0 p/ container.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
