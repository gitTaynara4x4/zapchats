# syntax=docker/dockerfile:1

########################
# 1) Builder (deps)
########################
FROM python:3.12-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# libs mínimas (psycopg2 usa libpq)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# venv cacheável
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .

# Falha cedo se houver marcadores de merge no requirements.txt
RUN ! grep -qE '^(<<<<<<<|=======|>>>>>>>)' requirements.txt || (echo '❌ requirements.txt tem marcadores de merge'; exit 1)

RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    pip install gunicorn uvicorn[standard]

########################
# 2) Runtime
########################
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# runtime leve
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# venv + código
COPY --from=builder /opt/venv /opt/venv
COPY . .

EXPOSE 8000

# 🚀 Rode gunicorn SEM shell e com caminho absoluto
ENTRYPOINT ["/opt/venv/bin/python","-m","gunicorn"]
CMD ["-k","uvicorn.workers.UvicornWorker","-w","1","-b","0.0.0.0:8000","--timeout","180","backend.main:app"]