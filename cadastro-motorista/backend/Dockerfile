FROM python:3.13-slim

WORKDIR /app

# Dependencias: Infosimples (httpx) + GPT-4o Vision (openai) + consultas externas.
# Fase 3 (2026-05-21): EasyOCR removido — imagem ~300MB menor.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# DC-283 / MED-7 — deixa de rodar como root.
#
# Este é o container MAIS exposto do conjunto: o Traefik roteia /ocr-api/* da
# internet direto pra ele, e ele processa upload de arquivo (CNH, selfie, CRLV).
# Era o único sem USER — backend, angelira e spx já rodavam como não-root.
# Container exposto + processamento de arquivo enviado por terceiro + root é a
# combinação que transforma uma falha de parsing em comprometimento do host.
#
# O diretório de anexos precisa pertencer ao usuário ANTES do USER: é onde o
# sidecar grava (anexos_tmp/<id>/<categoria>/...), e é ponto de montagem de
# volume — sem o chown aqui, o serviço sobe e falha na primeira escrita.
RUN useradd --create-home --shell /usr/sbin/nologin ocr \
    && mkdir -p /app/backend/anexos_tmp \
    && chown -R ocr:ocr /app

USER ocr

EXPOSE 8765

CMD ["python", "run.py"]
