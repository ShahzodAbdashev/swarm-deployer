"""Create, start and recover jobs."""
import os
import posixpath
import shutil
import threading
import uuid
from datetime import datetime

from backend.config.store import load_config
from backend.core.constants import DEPLOY_PHASES, DONE, ROLLBACK_PHASES
from backend.core.enums import DeployMode, JobKind, JobStatus, Phase, PhaseStatus
from backend.core.errors import bad
from backend.core.patterns import TAG_RE
from backend.core.paths import WORK
from backend.gitlab.ci_file import deploy_vars
from backend.jobs.runner import Runner
from backend.jobs.store import all_jobs, busy, busy_key, busy_lock, job_path, mapping_for
from backend.remote.fileserver import packages_target, read_zip_member
from backend.remote.ssh import connect_target
from backend.remote.swarm import service_info
from backend.utils.dates import now_iso
from backend.utils.files import write_json
from backend.utils.images import parse_pkg, repo_of, strip_digest


def new_job(kind, cfg, m, t, **fields):
    ts = datetime.now()
    phases = DEPLOY_PHASES if kind == JobKind.DEPLOY else ROLLBACK_PHASES
    job = {
        "id": uuid.uuid4().hex, "kind": kind, "ts": ts.strftime("%Y%m%d_%H%M%S"), "package": m["package"],
        "package_path": None, "version": None, "target": t["id"],
        "target_label": f"{t['username']}@{t['host']}:{t['port']}", "swarm_service": m["swarm_service"],
        "image_repo": m["image_repo"], "mode": DeployMode.UPDATE, "loaded_image": None, "new_image": None,
        "moving_image": f"{m['image_repo']}:{m['moving_tag']}" if m["moving_tag"] and m["moving_tag"] != "@current"
        else None, "moving_tag": m["moving_tag"],
        "package_format": None, "registry": None, "previous_ref": None, "previous_digest": None,
        "new_digest": None, "deploy_image": None, "pushed": [], "load_tags": {}, "health_script": False, "health_url": m.get("health_url") or "",
        "previous_image": None, "backup": None, "backup_id": None, "save_image_tar": cfg["options"]["save_image_tar"],
        "rollback": None, "status": JobStatus.RUNNING, "error": None, "created_at": ts.isoformat(timespec="seconds"),
        "finished_at": None,
        "phases": [{"name": p, "status": PhaseStatus.PENDING, "started_at": None, "finished_at": None, "message": ""}
                   for p in phases],
        "artifacts": {"zip_size": 0, "tar_size": 0, "tar_sha256": None, "remote_tar": None, "nodes_loaded": [],
                      "job_dir": None},
    }
    job.update(fields)
    return job


def start_job(job, cfg, password=None):
    key = busy_key(job)
    with busy_lock:
        if key in busy:
            bad(f"a deploy for {job['swarm_service'] or job['package']} on {job['target'] or 'its target'} "
                f"is already running", 409)
        busy.add(key)
    try:
        write_json(job_path(job["id"]), job)
        open(job_path(job["id"], "log"), "a").close()
        runner = Runner(job, cfg, password)
    except Exception:
        with busy_lock:
            busy.discard(key)
        raise
    threading.Thread(target=runner, daemon=True).start()
    return job


def recover_interrupted():
    """Startup: each job a dead server left running gets a background Runner.recover(). Its service stays busy
    (409 for new deploys) until recovery ends."""
    cfg = load_config()
    for j in all_jobs():
        if j["status"] in DONE:
            continue
        for p in j["phases"]:
            if p["status"] == PhaseStatus.RUNNING:
                p.update(status=PhaseStatus.FAILED, message="interrupted (server restart)", finished_at=now_iso())
            elif p["status"] == PhaseStatus.PENDING and p["name"] != Phase.CLEANUP:
                p.update(status=PhaseStatus.SKIPPED, message="skipped: interrupted")
        write_json(job_path(j["id"]), j)
        with busy_lock:
            busy.add(busy_key(j))
        try:
            runner = Runner(j, cfg)
        except Exception as e:  # e.g. its target was deleted from the config
            j.update(status=JobStatus.FAILED, finished_at=now_iso(),
                     error=f"interrupted (server restart); not recovered: {type(e).__name__}: {e}")
            write_json(job_path(j["id"]), j)
            shutil.rmtree(os.path.join(WORK, j["id"]), ignore_errors=True)
            with busy_lock:
                busy.discard(busy_key(j))
            continue
        threading.Thread(target=runner.recover, daemon=True).start()


def plan_deploy(cfg, path, pw, tid=None):
    """Where the package goes, with nothing to pick: SERVICE_NAME / DEV_IMAGE_TAG / HEALTHCHECK_URL from the zip's
    .gitlab-ci.yml (read in place; also checks the password), else the package's last deploy. The target is the
    one the package is on (tid, else the only one). The image repo comes from what the service runs now. Returns
    (mapping, target, current image)."""
    pkg = parse_pkg(posixpath.basename(path))[0]
    t = packages_target(cfg, tid)
    tid = t["id"]
    try:
        raw = read_zip_member(t, path, ".gitlab-ci.yml", pw)
    except RuntimeError:
        bad("password: wrong zip password")
    except FileNotFoundError:
        bad(f"package_path: not found on {tid}", 404)
    except Exception as e:
        bad(f"target {tid}: {type(e).__name__}: {e}", 502)
    try:
        ci = deploy_vars(raw.decode("utf-8", "replace")) if raw else {}
        if ci.get("tag") and not TAG_RE.fullmatch(ci["tag"]):
            bad(f"package: DEV_IMAGE_TAG={ci['tag']!r} in .gitlab-ci.yml is not a valid image tag")
    except ValueError as e:
        bad(f"package: {e}")
    last = mapping_for(cfg, pkg) or {}
    svc = ci.get("service") or last.get("swarm_service")
    if not svc:
        bad(f"package: no SERVICE_NAME — the zip has no .gitlab-ci.yml with it and {pkg} was never deployed")
    try:
        sh = connect_target(t)
    except Exception as e:
        bad(f"target: {type(e).__name__}: {e}", 502)
    try:
        info = service_info(sh, svc)
    finally:
        sh.close()
    if not info:
        bad(f"package: SERVICE_NAME={svc} is not a service on {tid}", 404)
    img = info["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
    repo = repo_of(strip_digest(img))
    health = ci.get("health_url") or last.get("health_url") or ""
    ports = [p for p in ((info.get("Endpoint") or {}).get("Ports") or []) if p.get("PublishedPort")]
    if not health and len(ports) == 1:  # ponytail: fortress services serve /healthcheck; set HEALTHCHECK_URL if not
        health = f"http://127.0.0.1:{ports[0]['PublishedPort']}/healthcheck"
    m = {"package": pkg, "target": tid, "swarm_service": svc, "image_repo": repo,
         "moving_tag": ci.get("tag") or "@current", "ci_tag": ci.get("tag"), "health_url": health,
         "source": "gitlab-ci" if ci.get("service") else "last-deploy"}
    return m, t, strip_digest(img)


def start_deploy(path, pw, sit=None, tid=None):
    """path: validated /dir/<package file> on the target (parse_pkg accepts its name)."""
    svc, ver, fmt = parse_pkg(posixpath.basename(path))
    cfg = load_config()
    m, t, _img = plan_deploy(cfg, path, pw, tid)
    job = new_job(JobKind.DEPLOY, cfg, m, t, package=svc, package_path=path, version=ver, ci_tag=m["ci_tag"],
                  new_image=f"{m['image_repo']}:{ver}" if ver else None, package_format=fmt,
                  save_image_tar=cfg["options"]["save_image_tar"] if sit is None else sit)
    if not ver:  # format (2) without a ts in the name: the version is the job ts (AD-3)
        job["version"] = job["ts"]
        job["new_image"] = f"{m['image_repo']}:{job['ts']}"
    return start_job(job, cfg, pw)
