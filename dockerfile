# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.12-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Build deps necessários p/ wheels nativos (bcrypt/cffi etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libffi-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# venv cacheável
RUN python -m venv /opt/venv

# Só requirements no builder
COPY requirements.txt .

# Falha cedo se houver marcadores de merge no requirements.txt
RUN ! grep -qE '^(<<<<<<<|=======|>>>>>>>)' requirements.txt || (echo '❌ requirements.txt tem marcadores de merge'; exit 1)

# Instala deps (sem cache, preferindo wheels)
RUN /opt/venv/bin/pip install --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir --prefer-binary -r requirements.txt

########################
# 2) Runtime (leve)
########################
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Somente libs de runtime (libpq p/ psycopg2, libffi p/ bcrypt/cffi, certificados)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 libffi8 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# venv + código
COPY --from=builder /opt/venv /opt/venv
COPY . .

EXPOSE 8000

# 🚀 Gunicorn + UvicornWorker
ENTRYPOINT ["/opt/venv/bin/gunicorn"]
CMD ["-k","uvicorn.workers.UvicornWorker","-w","1","-b","0.0.0.0:8000","--timeout","180","backend.main:app"]
