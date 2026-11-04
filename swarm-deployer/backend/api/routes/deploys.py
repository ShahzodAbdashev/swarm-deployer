"""Deploys, rollbacks and their logs."""
import asyncio
import json
import os
import posixpath
import re
import shutil

from fastapi import APIRouter, Body
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.api.deps import obj
from backend.config.store import find, load_config
from backend.core.constants import DONE
from backend.core.enums import JobKind
from backend.core.errors import bad
from backend.core.paths import WORK
from backend.core.patterns import BACKUP_ID_RE, TS_RE
from backend.jobs.manager import new_job, plan_deploy, start_deploy, start_job
from backend.jobs.store import all_jobs, job_path, load_job
from backend.remote.fileserver import need_file_server
from backend.remote.swarm import need_mapping
from backend.utils.images import parse_pkg, registry_mode
from backend.validators.fields import clean_remote_dir, v_bool, v_re, v_str

router = APIRouter()


@router.post("/api/deploys", status_code=201)
def create_deploy(body: dict = Body(default={})):
    body = obj(body)
    path = body.get("package_path")
    um = re.fullmatch(r"sftp://([^/:]+)(?::(\d+))?(/.*)", path.strip()) if isinstance(path, str) else None
    if um:  # Build Packager reports artifacts.remote_path as a URL; accept it for our own file server
        fs = need_file_server(load_config())
        if (um[1], int(um[2] or fs["port"])) != (fs["host"], fs["port"]):
            bad("package_path: URL does not match the configured file server")
        path = um[3]
    path = clean_remote_dir(path, "package_path")
    if not parse_pkg(posixpath.basename(path)):
        bad("package_path: file name must be <service>_<YYYYMMDD_HHMMSS>.zip, <name>.tar.zip or <name>.zip")
    pw = body.get("password")
    if not isinstance(pw, str) or not 1 <= len(pw) <= 1024:
        bad("password: required (max 1024 characters)")
    sit = body.get("save_image_tar")
    if sit is not None:
        v_bool(sit, "save_image_tar")
    return start_deploy(path, pw, sit)


@router.post("/api/deploys/plan")
def plan(body: dict = Body(default={})):
    """What a deploy of this package would do (nothing changes): service, image, tag, health check."""
    body = obj(body)
    path = clean_remote_dir(body.get("package_path"), "package_path")
    if not parse_pkg(posixpath.basename(path)):
        bad("package_path: not a package file name")
    pw = body.get("password")
    if not isinstance(pw, str) or not 1 <= len(pw) <= 1024:
        bad("password: required (max 1024 characters)")
    m, t, img = plan_deploy(load_config(), path, pw)
    return {**m, "target_name": t.get("name") or t["id"], "registry": registry_mode(t, m["image_repo"]) and t["registry"]["url"],
            "current_image": img}


@router.post("/api/rollbacks", status_code=201)
def create_rollback(body: dict = Body(default={})):
    body = obj(body)
    cfg = load_config()
    m = need_mapping(cfg, v_str(body.get("package"), "package", 63))
    bid = v_re(body.get("backup_id"), "backup_id", BACKUP_ID_RE)
    if not bid.startswith(m["swarm_service"] + "_") or not TS_RE.fullmatch(bid[len(m["swarm_service"]) + 1:]):
        bad(f"backup_id: not a backup of {m['swarm_service']}")
    t = find(cfg["targets"], "id", m["target"])
    ts = bid[-15:]
    job = new_job(JobKind.ROLLBACK, cfg, m, t, backup_id=bid, version=ts, new_image=f"{m['image_repo']}:backup-{ts}",
                  save_image_tar=False)
    return start_job(job, cfg)


@router.get("/api/deploys")
def list_deploys(package: str | None = None):
    jobs = all_jobs()
    return [j for j in jobs if j["package"] == package] if package else jobs


@router.get("/api/deploys/{jid}")
def get_deploy(jid: str):
    return load_job(jid)


@router.get("/api/deploys/{jid}/log")
def get_log(jid: str):
    load_job(jid)
    try:
        with open(job_path(jid, "log"), encoding="utf-8", errors="replace") as f:
            return PlainTextResponse(f.read())
    except OSError:
        return PlainTextResponse("")


@router.get("/api/deploys/{jid}/logs/stream")
async def stream_log(jid: str):
    load_job(jid)
    logp, jp = job_path(jid, "log"), job_path(jid)

    async def gen():
        pos, buf, last_raw, idle = 0, b"", None, 0.0
        while True:
            try:  # read json BEFORE log: the runner writes the final log line before the final json
                with open(jp) as f:
                    raw = f.read()
                job = json.loads(raw)
            except (OSError, ValueError):
                if last_raw is None:
                    await asyncio.sleep(0.3)
                    continue
                raw, job = last_raw, json.loads(last_raw)
            out = []
            try:
                with open(logp, "rb") as f:
                    f.seek(pos)
                    chunk = f.read()
                    pos = f.tell()
            except OSError:
                chunk = b""
            buf += chunk
            *lines, buf = buf.split(b"\n")
            out += [f"event: log\ndata: {ln.decode('utf-8', 'replace')}\n\n" for ln in lines]
            if raw != last_raw:
                last_raw = raw
                out.append(f"event: status\ndata: {json.dumps(job)}\n\n")
            if job["status"] in DONE:
                out.append(f"event: end\ndata: {json.dumps({'status': job['status']})}\n\n")
            if out:
                idle = 0.0
                yield "".join(out)
            if job["status"] in DONE:
                return
            await asyncio.sleep(0.3)
            idle += 0.3
            if idle >= 15:
                idle = 0.0
                yield ": ping\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.delete("/api/deploys/{jid}")
def delete_deploy(jid: str):
    job = load_job(jid)
    if job["status"] not in DONE:
        bad("deploy is still running", 409)
    shutil.rmtree(os.path.join(WORK, jid), ignore_errors=True)
    for p in (job_path(jid, "log"), job_path(jid)):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    return {"deleted": True}
