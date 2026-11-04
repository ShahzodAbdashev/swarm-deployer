"""Job files on disk and the per-service busy set."""
import json
import os
import threading

from backend.config.store import find
from backend.core.enums import JobKind
from backend.core.errors import bad
from backend.core.paths import DEPLOYS
from backend.core.patterns import JOB_ID_RE


busy, busy_lock = set(), threading.Lock()


def busy_key(job):
    """Per-service lock key (job files from before mappings were required may lack the service)."""
    return (job["target"], job["swarm_service"]) if job["swarm_service"] else ("", "pkg:" + job["package"])


def known_services(cfg):
    """What was deployed where: the newest deploy of each package (no saved mappings; the service is picked at
    deploy time). Feeds the services page, backups and rollback. Targets deleted since are left out."""
    seen = {}
    for j in all_jobs():  # newest first
        if j["kind"] == JobKind.DEPLOY and j.get("swarm_service") and j["package"] not in seen \
                and find(cfg["targets"], "id", j["target"]):
            seen[j["package"]] = {"package": j["package"], "target": j["target"], "swarm_service": j["swarm_service"],
                                  "image_repo": j["image_repo"], "moving_tag": j.get("moving_tag") or "",
                                  "health_url": j.get("health_url") or ""}
    return list(seen.values())


def mapping_for(cfg, package):
    return next((m for m in known_services(cfg) if m["package"] == package), None)


def job_path(jid, ext="json"):
    return os.path.join(DEPLOYS, f"{jid}.{ext}")


def load_job(jid):
    if not JOB_ID_RE.fullmatch(jid or ""):
        bad("deploy not found", 404)
    try:
        with open(job_path(jid)) as f:
            return json.load(f)
    except (OSError, ValueError):
        bad("deploy not found", 404)


def all_jobs():
    out = []
    for n in os.listdir(DEPLOYS):
        if n.endswith(".json"):
            try:
                with open(os.path.join(DEPLOYS, n)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return sorted(out, key=lambda j: (j["created_at"], j["ts"]), reverse=True)
