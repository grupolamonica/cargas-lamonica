FROM python:3.12-slim

RUN pip install --no-cache-dir requests playwright \
 && playwright install --with-deps chromium

WORKDIR /app
COPY asp.py .

CMD ["python", "asp.py", "--service-loop"]
