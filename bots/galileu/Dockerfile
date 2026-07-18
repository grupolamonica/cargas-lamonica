# Coletor Nestlé (Projeto Galileu adaptado) — extrai ofertas do TMS Galileo e faz
# upsert em nestle_ofertas do banco do Cargas Lamônica. Loop simples (sem HTTP);
# roda como serviço no docker-compose, na rede privada lamonica-net.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY run_coleta.py .
COPY nestle/ ./nestle/

# Usuário não-root
RUN useradd -m bot && chown -R bot /app
USER bot

CMD ["python", "run_coleta.py"]
