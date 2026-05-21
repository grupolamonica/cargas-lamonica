FROM python:3.13-slim

WORKDIR /app

# Dependencias: Infosimples (httpx) + GPT-4o Vision (openai) + consultas externas.
# Fase 3 (2026-05-21): EasyOCR removido — imagem ~300MB menor.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8765

CMD ["python", "run.py"]
