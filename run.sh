#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

# UI (React + Vite in frontend/, shared kit in ../shared-ui): build when missing or older than its sources
if [ ! -f frontend/dist/index.html ] || [ -n "$(find frontend/src frontend/index.html frontend/package.json ../shared-ui/src \
     -newer frontend/dist/index.html -print -quit 2>/dev/null)" ]; then
  command -v npm >/dev/null || { echo "npm (Node 18+) is needed to build the UI: see README" >&2; exit 1; }
  (
    cd frontend
    if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then npm ci --no-audit --no-fund; fi
    npm run build
  )
fi

exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8095
