#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

# UI: plain static files in frontend/ (no build step), served by the backend
exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8095
