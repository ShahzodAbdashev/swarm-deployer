"""Build jobs: create, list, logs, downloads, delete."""
import asyncio
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse

from backend.api.schemas import JobIn
from backend.config.store import load_config
from backend.core.constants import DONE, STEPS
from backend.core.enums import JobStatus, StepStatus
from backend.core.errors import bad
from backend.core.paths import WS
from backend.core.patterns import NAME_RE
from backend.envfile.parser import parse_env
from backend.gitlab.client import gl_base, need_gitlab
from backend.jobs.runner import Runner
from backend.jobs.store import all_jobs, create_lock, job_path, load_job, tar_name
from backend.utils.files import write_json
from backend.validators.fields import clean_remote_dir, url_basename, valid_branch, valid_url

router = APIRouter()


@router.post("/api/jobs", status_code=201)
def create_job(body: JobIn):
    # docker image names: lowercase alnum separated by single . _ __ or dashes
    if not NAME_RE.match(body.service) or not re.fullmatch(r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*", body.service.lower()):
        bad("service: invalid name")
    if not valid_url(body.repo_url):
        bad("repo_url: invalid URL")
    if not valid_branch(body.branch):
        bad("branch: invalid branch name")
    dockerfile = body.dockerfile or "Dockerfile"
    if os.path.isabs(dockerfile) or ".." in dockerfile:
        bad("dockerfile: must be a relative path without '..'")
    build_command = (body.build_command or "").strip()
    if len(build_command) > 2000:
        bad("build_command: max 2000 characters")
    if len(body.password) < 4:
        bad("password: at least 4 characters")
    if body.password != body.password_confirm:
        bad("password: must match confirmation")
    env = None
    if body.env is not None:
        e = body.env
        keys = list(parse_env(e.content)) if 0 < len(e.content) <= 65536 else []
        if not keys:
            bad("env.content: no KEY=value lines")
        ep = e.path or ""
        if (not ep or len(ep) > 200 or ep.startswith(("/", "-")) or ".." in ep.split("/")
                or any(ord(ch) < 32 for ch in ep)):
            bad("env.path: must be a relative path inside the repo without '..'")
        env = {"path": ep, "keys": keys, "count": len(keys),
               "source": e.source if e.source in ("paste", "file", "gitlab") else "paste", "written": None}
    if len(body.preload_tars) > 20:
        bad("preload_tars: at most 20")
    for i, t in enumerate(body.preload_tars):
        if (not os.path.isabs(t) or len(t) > 1024 or any(ord(ch) < 32 for ch in t)
                or not os.path.isfile(t)):
            bad(f"preload_tars[{i}]: not a file on this computer")
    ts = datetime.now()
    tsf = ts.strftime("%Y%m%d_%H%M%S")
    folder = f"{body.service}_{tsf}"
    repo_name = url_basename(body.repo_url)
    if not NAME_RE.match(repo_name):
        repo_name = "repo"
    tarn = f"{body.service}_{body.branch.replace('/', '-')}_{tsf}.tar"
    taken, extras = {repo_name, tarn}, []
    for i, e in enumerate(body.extra_repos):
        if not valid_url(e.url):
            bad(f"extra_repos[{i}].url: invalid URL")
        if not valid_branch(e.branch):
            bad(f"extra_repos[{i}].branch: invalid branch name")
        name = e.name or url_basename(e.url)
        if not NAME_RE.match(name):
            bad(f"extra_repos[{i}].name: invalid name")
        if name in taken:
            bad(f"extra_repos[{i}].name: duplicate name '{name}'")
        taken.add(name)
        extras.append({"url": e.url, "branch": e.branch, "name": name})
    job = {
        "id": uuid.uuid4().hex, "service": body.service, "ts": tsf, "folder_name": folder,
        "repo_url": body.repo_url, "branch": body.branch, "dockerfile": dockerfile, "build_command": build_command,
        "extra_repos": extras, "upload_requested": body.upload,
        "remote_dir": clean_remote_dir(body.remote_dir) if body.remote_dir and body.remote_dir.strip() else None, "image_tag": f"{body.service.lower()}:{tsf}",
        "status": JobStatus.QUEUED, "error": None, "created_at": ts.isoformat(timespec="seconds"), "finished_at": None,
        "steps": [{"name": s, "status": StepStatus.PENDING, "started_at": None, "finished_at": None, "message": ""}
                  for s in STEPS],
        "artifacts": {"tar": False, "zip": False, "tar_size": 0, "zip_size": 0, "remote_path": None},
        "repo_name": repo_name, "tar_name": tarn, "deploy_manifest": None,
        "env": env, "preload_tars": list(body.preload_tars), "healthcheck": False,
    }
    with create_lock:  # ponytail: scans all job files per create; fine for a local single-user tool
        if os.path.exists(os.path.join(WS, folder)) or any(j["folder_name"] == folder for j in all_jobs()):
            bad(f"a job for {folder} already exists, retry in a second", 409)
        write_json(job_path(job["id"]), job)
        open(job_path(job["id"], "log"), "a").close()
    try:  # best effort: not signed in to GitLab -> no token injection, the job still runs
        gl = (gl_base(), need_gitlab())
    except HTTPException:
        gl = None
    runner = Runner(job, body.password, load_config()["github_token"], gl, body.env.content if env else None)
    threading.Thread(target=runner, daemon=True).start()
    return job


@router.get("/api/jobs")
def list_jobs():
    return all_jobs()


@router.get("/api/jobs/{jid}")
def get_job(jid: str):
    return load_job(jid)


@router.get("/api/jobs/{jid}/log")
def get_log(jid: str):
    load_job(jid)
    try:
        with open(job_path(jid, "log"), encoding="utf-8", errors="replace") as f:
            return PlainTextResponse(f.read())
    except OSError:
        return PlainTextResponse("")


@router.get("/api/jobs/{jid}/logs/stream")
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
                raw, job = last_raw, None  # mid-replace or deleted; retry next tick
                if last_raw is None:
                    await asyncio.sleep(0.3)
                    continue
                job = json.loads(last_raw)
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


def download(jid, kind):
    job = load_job(jid)
    name = tar_name(job) if kind == "tar" else f"{job['folder_name']}.zip"
    path = os.path.join(WS, job["folder_name"], name) if kind == "tar" else os.path.join(WS, name)
    if not os.path.isfile(path):
        bad(f"{kind} not available", 409)
    media = "application/zip" if kind == "zip" else "application/x-tar"
    return FileResponse(path, media_type=media, filename=name)


@router.get("/api/jobs/{jid}/download/zip")
def download_zip(jid: str):
    return download(jid, "zip")


@router.get("/api/jobs/{jid}/download/tar")
def download_tar(jid: str):
    return download(jid, "tar")


@router.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    job = load_job(jid)
    if job["status"] not in DONE:
        bad("job is still running", 409)
    F = os.path.join(WS, job["folder_name"])
    shutil.rmtree(F, ignore_errors=True)
    for p in (F + ".zip", job_path(jid, "log"), job_path(jid)):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    return {"deleted": True}
