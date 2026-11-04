# syntax=docker/dockerfile:1
# Build:  docker build --build-context shared-ui=../shared-ui -t devtools/build-packager .
# (docker compose in ../devtools-stack passes the shared-ui context for you)

FROM node:20 AS ui
WORKDIR /src
COPY --from=shared-ui . shared-ui/
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc app/frontend/
RUN cd app/frontend && npm ci --no-audit --no-fund
COPY frontend/ app/frontend/
RUN cd app/frontend && npm run build

FROM python:3.12-slim-bookworm
# git: clone · gh: "Use gh CLI token" (reads GH_TOKEN) · docker CLI + buildx: builds on the mounted host daemon
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-dind /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-dind /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
COPY backend/ backend/
COPY --from=ui /src/app/frontend/dist frontend/dist
# 127.0.0.1 only: the compose file uses host networking, so this stays local-only like run.sh
CMD ["uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8090"]
