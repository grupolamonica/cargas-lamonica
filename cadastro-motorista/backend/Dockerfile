FROM python:3.13-slim

WORKDIR /app

# Instala dependências base (Infosimples + consultas externas)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# OCR local via EasyOCR — necessário APENAS para cartão CNPJ (Infosimples
# não tem endpoint Imagens para esse documento). Comprovante de residência
# funciona via Infosimples `ocr/contas/<concessionaria>`. Habilitar abaixo
# adiciona ~700MB (torch). Mantemos opcional/comentado para builds rápidos
# em dev; em produção, descomentar e rebuildar uma vez.
# COPY requirements-ocr.txt .
# RUN pip install --no-cache-dir -r requirements-ocr.txt
# RUN python -c "import easyocr; easyocr.Reader(['pt','en'], gpu=False)"

COPY . .

EXPOSE 8765

CMD ["python", "run.py"]
