# syntax=docker/dockerfile:1
# Build:  docker build --build-context shared-ui=../shared-ui -t devtools/swarm-deployer .
# (docker compose in ../devtools-stack passes the shared-ui context for you)

FROM node:20 AS ui
WORKDIR /src
COPY --from=shared-ui . shared-ui/
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc app/frontend/
RUN cd app/frontend && npm ci --no-audit --no-fund
COPY frontend/ app/frontend/
RUN cd app/frontend && npm run build

FROM python:3.12-slim-bookworm
# no docker here on purpose: every docker/swarm command runs over SSH on the target server
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
COPY backend/ backend/
COPY --from=ui /src/app/frontend/dist frontend/dist
ENV SD_DATA=/data
CMD ["uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8095"]
