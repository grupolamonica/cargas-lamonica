FROM python:3.13-slim

WORKDIR /app

# Instala dependências base (Infosimples + consultas externas)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# OCR local opcional via EasyOCR — comentar se usar apenas Infosimples
# COPY requirements-ocr.txt .
# RUN pip install --no-cache-dir -r requirements-ocr.txt

COPY . .

EXPOSE 8765

CMD ["python", "run.py"]
