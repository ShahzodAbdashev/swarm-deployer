"""Docker Swarm service queries and the services overview."""
import json
import time
from concurrent.futures import ThreadPoolExecutor

from backend.config.store import find
from backend.core.errors import bad
from backend.jobs.store import all_jobs, mapping_for
from backend.remote.ssh import connect_target
from backend.utils.images import split_ref, strip_digest
from backend.utils.text import jparse


def service_info(sh, svc):
    """docker service inspect as dict, or None if missing."""
    code, out = sh.run(sh.D + ["service", "inspect", "--format", "{{json .}}", svc], quiet=True)
    return jparse(out) if code == 0 else None


def service_tasks(sh, svc):
    code, out = sh.run(sh.D + ["service", "ps", svc, "--no-trunc", "--filter", "desired-state=running",
                               "--format", "{{json .}}"],
                       quiet=True)
    out_tasks = []
    for ln in out.splitlines():
        if ln.startswith("{"):
            try:
                out_tasks.append(json.loads(ln))
            except ValueError:
                pass
    return out_tasks


def running(tasks):
    return [t for t in tasks if str(t.get("CurrentState", "")).startswith("Running")]


def service_row(sh, m):
    info = service_info(sh, m["swarm_service"])
    if not info:
        return {"exists": False, "current_image": None, "current_digest": None, "replicas_running": 0,
                "replicas_desired": 0, "update_state": None}
    spec = info.get("Spec") or {}
    tasks = service_tasks(sh, m["swarm_service"])
    desired = ((spec.get("Mode") or {}).get("Replicated") or {}).get("Replicas")
    img = spec.get("TaskTemplate", {}).get("ContainerSpec", {}).get("Image")
    return {"exists": True, "current_image": strip_digest(img), "current_digest": split_ref(img)[2],
            "replicas_running": len(running(tasks)),
            "replicas_desired": desired if desired is not None else len(tasks),
            "update_state": (info.get("UpdateStatus") or {}).get("State")}


def last_deploy(package, jobs):
    j = next((x for x in jobs if x["package"] == package), None)
    return j and {k: j[k] for k in ("id", "kind", "status", "version", "finished_at")}


def services_rows(mappings, cfg):
    jobs = all_jobs()
    by_target = {}
    for m in mappings:
        by_target.setdefault(m["target"], []).append(m)

    def per_target(tid):
        t = find(cfg["targets"], "id", tid)
        sh = connect_target(t)
        try:
            return {m["package"]: service_row(sh, m) for m in by_target[tid]}
        finally:
            sh.close()
    pool = ThreadPoolExecutor(max(1, len(by_target)))
    futs = {tid: pool.submit(per_target, tid) for tid in by_target}
    deadline, results = time.monotonic() + 15, {}
    for tid, f in futs.items():
        try:
            results.update(f.result(timeout=max(0.1, deadline - time.monotonic())))
        except Exception as e:
            err = "timed out" if isinstance(e, TimeoutError) else f"{type(e).__name__}: {e}"
            results.update({m["package"]: {"error": err} for m in by_target[tid]})
    pool.shutdown(wait=False)
    rows = []
    for m in mappings:
        r = results.get(m["package"], {})
        t = find(cfg["targets"], "id", m["target"]) or {}
        rows.append({"package": m["package"], "target": m["target"], "swarm_service": m["swarm_service"],
                     "image_repo": m["image_repo"], "exists": r.get("exists"), "current_image": r.get("current_image"),
                     "current_digest": r.get("current_digest"), "moving_tag": m.get("moving_tag"),
                     "health_url": m.get("health_url") or "",
                     "registry": (t.get("registry") or {}).get("url") or None,
                     "replicas_running": r.get("replicas_running"), "replicas_desired": r.get("replicas_desired"),
                     "update_state": r.get("update_state"), "last_deploy": last_deploy(m["package"], jobs),
                     "error": r.get("error")})
    return rows


def need_mapping(cfg, package):
    m = mapping_for(cfg, package)
    if not m:
        bad(f"{package}: not deployed yet", 404)
    return m
