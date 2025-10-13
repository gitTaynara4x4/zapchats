# syntax=docker/dockerfile:1
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependências nativas se precisar compilar libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Copia o projeto
COPY . /app

# Usuário não-root
RUN useradd -ms /bin/bash appuser
USER appuser

EXPOSE 2011
# Ajuste "main:app" para o caminho correto (ex.: backend.main:app)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "2011"]
