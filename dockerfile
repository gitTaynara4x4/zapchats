# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Só libs de runtime necessárias (psycopg2 usa libpq)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências em um venv separado (cache amigável)
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt \
    && pip install "gunicorn>=21.2" "uvicorn[standard]>=0.30"

########################
# 2) Runtime
########################
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ENV=prod \
    PYTHONPATH=/app

# Mesmas libs de runtime (pequenas)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Copia apenas o venv já pronto do builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY . .

# Garante que o pacote backend é importável e pasta de uploads exista
RUN mkdir -p /app/uploads && \
    [ -f backend/__init__.py ] || printf "" > backend/__init__.py

# Segurança: roda como usuário não-root
RUN useradd -r -s /sbin/nologin appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Healthcheck bate na rota /healthz (já existe no teu main.py)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

# Produção: gunicorn + uvicorn worker
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000", "--timeout", "120", "backend.main:app"]
