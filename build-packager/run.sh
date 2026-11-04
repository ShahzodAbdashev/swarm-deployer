#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
# the UI is plain static files in frontend/, served by the backend: nothing to build
exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8090
