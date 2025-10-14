# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# libs mínimas de runtime (psycopg2 usa libpq)
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
    MEDIA_CACHE_DIR=/var/cache/zapchats \
    # evitar "Consumindoâ€¦"
    PYTHONIOENCODING=UTF-8 LANG=C.UTF-8 LC_ALL=C.UTF-8

# libs mínimas de runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# venv pronto do builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY . .

# garantir pacote importável e pastas de escrita
RUN mkdir -p /app/uploads "${MEDIA_CACHE_DIR}" && \
    [ -f backend/__init__.py ] || printf "" > backend/__init__.py

# usuário não-root + permissões nas pastas de escrita
RUN groupadd -r appuser && useradd -r -g appuser -s /usr/sbin/nologin appuser && \
    chown -R appuser:appuser /app "${MEDIA_CACHE_DIR}"

USER appuser

EXPOSE 8000

# healthcheck simples
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# Produção: gunicorn + uvicorn worker
# WORKERS é configurável em runtime (padrão 1 para evitar duplicar listeners de WS/Rabbit)
ENV WORKERS=1
CMD ["/bin/sh","-lc","gunicorn -k uvicorn.workers.UvicornWorker -w ${WORKERS:-1} -b 0.0.0.0:8000 --timeout 120 backend.main:app"]
