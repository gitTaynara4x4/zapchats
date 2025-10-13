# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# libs mínimas (psycopg2 usa libpq)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# venv para cachear dependências
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    pip install "gunicorn>=21.2" "uvicorn[standard]>=0.30"

########################
# 2) Runtime
########################
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ENV=prod \
    PYTHONPATH=/app \
    # <- ajuste aqui se quiser trocar o caminho do cache
    MEDIA_CACHE_DIR=/var/cache/zapchats

# libs runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# venv do builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY . .

# pastas necessárias + __init__ do backend
RUN mkdir -p /app/uploads && \
    [ -f backend/__init__.py ] || printf "" > backend/__init__.py

# **cria e dá permissão nas pastas que o app escreve**
RUN mkdir -p /var/cache/zapchats /app/uploads && \
    groupadd -r appuser && useradd -r -g appuser -s /sbin/nologin appuser && \
    chown -R appuser:appuser /var/cache/zapchats /app

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# Produção: gunicorn com worker do uvicorn
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000", "--timeout", "120", "backend.main:app"]
