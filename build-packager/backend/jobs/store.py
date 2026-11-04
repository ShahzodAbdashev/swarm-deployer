"""Job files on disk."""
import json
import os
import threading

from backend.core.errors import bad
from backend.core.paths import JOBS
from backend.core.patterns import JOB_ID_RE


create_lock = threading.Lock()


def job_path(jid, ext="json"):
    return os.path.join(JOBS, f"{jid}.{ext}")


def load_job(jid):
    if not JOB_ID_RE.match(jid or ""):
        bad("job not found", 404)
    try:
        with open(job_path(jid)) as f:
            return json.load(f)
    except (OSError, ValueError):
        bad("job not found", 404)


def all_jobs():
    out = []
    for n in os.listdir(JOBS):
        if n.endswith(".json"):
            try:
                with open(os.path.join(JOBS, n)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return sorted(out, key=lambda j: j["created_at"], reverse=True)


def tar_name(job):
    """<service>_<branch>_<ts>.tar; '/' in branch -> '-'. Old jobs (no tar_name) keep <folder>.tar."""
    return job.get("tar_name") or job["folder_name"] + ".tar"
