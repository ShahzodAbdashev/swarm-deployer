"""Data directory layout (SD_DATA) and the built UI folder. Creates the data dirs on import."""
import os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # swarm-deployer/
DATA = os.path.abspath(os.environ.get("SD_DATA") or os.path.join(BASE, "data"))
DEPLOYS = os.path.join(DATA, "deploys")
AUTO_STATE = os.path.join(DATA, "auto_state.json")
WORK = os.path.join(DATA, "work")
CONFIG = os.path.join(DATA, "config.json")
KNOWN_HOSTS = os.path.join(DATA, "known_hosts")
KEYS = os.path.join(DATA, "keys")
DIST = os.path.join(BASE, "frontend", "dist")  # React build output (frontend/, `npm run build`; run.sh builds it)

for _d in (DATA, DEPLOYS, WORK):
    os.makedirs(_d, exist_ok=True)

os.chmod(DATA, 0o700)  # tokens, image tars and .env files inside: private to this user

if not os.path.exists(KNOWN_HOSTS):
    open(KNOWN_HOSTS, "a").close()
    os.chmod(KNOWN_HOSTS, 0o600)
