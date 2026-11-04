"""Data layout (BASE/data): jobs, workspace, config. Creates the dirs on import."""
import os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # build-packager/
DATA = os.path.join(BASE, "data")
JOBS = os.path.join(DATA, "jobs")
WS = os.path.join(DATA, "workspace")
CONFIG = os.path.join(DATA, "config.json")
DIST = os.path.join(BASE, "frontend", "dist")  # React build output (`npm run build`; run.sh builds it when needed)

for d in (DATA, JOBS, WS):
    os.makedirs(d, exist_ok=True)

os.chmod(DATA, 0o700)  # tokens, image tars and .env files inside: private to this user
