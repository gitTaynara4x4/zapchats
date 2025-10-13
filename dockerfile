# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# libs de runtime (psycopg2 usa libpq; tzdata p/ ZoneInfo)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl tzdata && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# venv dedicado (melhor cache nas camadas)
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# ---- Dependências Python
COPY requirements.txt ./
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    # Garantias caso não estejam no requirements.txt
    pip install --no-cache-dir \
      "psycopg2-binary>=2.9" \
      "email-validator>=2.1" \
      "pydantic[email]>=2.0" \
      "python-multipart>=0.0.9" \
      "gunicorn>=23.0.0" \
      "uvicorn[standard]>=0.30.0"

########################
# 2) Runtime
########################
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ENV=prod \
    PYTHONPATH=/app \
    TZ=Etc/UTC

# libs mínimas de runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl tzdata && \
    rm -rf /var/lib/apt/lists/*

# traz o venv pronto do builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY . .

# garante pacote importável e pasta de uploads
RUN mkdir -p /app/uploads && \
    [ -f backend/__init__.py ] || printf "" > backend/__init__.py

# segurança: usuário não-root
RUN useradd -r -s /sbin/nologin appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Healthcheck na rota /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# Produção: gunicorn + uvicorn worker
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "backend.main:app"]
