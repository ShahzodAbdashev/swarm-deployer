# syntax=docker/dockerfile:1
# Build:  docker build -t devtools/swarm-deployer .

FROM python:3.12-slim-bookworm
# no docker here on purpose: every docker/swarm command runs over SSH on the target server
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./
COPY backend/ backend/
COPY frontend/ frontend/
ENV SD_DATA=/data
CMD ["uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8095"]
