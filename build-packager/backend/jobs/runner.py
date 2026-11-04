"""Runner: one build job, step by step (clone, build, save, zip, upload)."""
import os
import posixpath
import shutil
import subprocess
from datetime import datetime

import pyzipper

from backend.config.store import load_config
from backend.core.enums import JobStatus, Protocol, StepStatus
from backend.core.errors import Skip, StepFailed
from backend.core.paths import WS
from backend.envfile.parser import env_secrets, parse_env
from backend.github.client import auth_url
from backend.jobs.store import job_path, tar_name
from backend.remote.upload import remote
from backend.utils.dates import now_iso
from backend.utils.files import write_json
from backend.validators.manifest import check_manifest


class Runner:
    def __init__(self, job, password, token, gl=None, env=None):
        self.job, self.secret, self.token, self.gl = job, {"password": password, "env": env}, token, gl
        self.masks = sorted({m for m in [token, gl and gl[1], password, load_config()["upload"]["password"],
                                         *env_secrets(parse_env(env or ""))] if m},
                            key=len, reverse=True)
        self.F = os.path.join(WS, job["folder_name"])
        self.logf = open(job_path(job["id"], "log"), "a", encoding="utf-8")

    def save(self):
        write_json(job_path(self.job["id"]), self.job)

    def mask(self, text):
        for m in self.masks:
            text = text.replace(m, "***")
        return text

    def log(self, text):
        text = self.mask(text)
        stamp = datetime.now().strftime("%H:%M:%S")
        for line in text.replace("\r", "\n").split("\n"):
            if line:
                self.logf.write(f"[{stamp}] {line}\n")
        self.logf.flush()

    def run(self, argv, cwd=None, shell=False):
        self.log("$ " + (argv if shell else " ".join(argv)))
        env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
        try:
            p = subprocess.Popen(argv, cwd=cwd, shell=shell, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, bufsize=1,
                                 errors="replace")
        except OSError as e:
            raise StepFailed(f"cannot run {argv if shell else argv[0]}: {e}")
        last = ""
        for line in p.stdout:
            self.log(line.rstrip("\n"))
            if line.strip():
                last = line.strip()
        if p.wait() != 0:
            # surface the tool's own last words (e.g. git "fatal: ...") instead of a bare exit code
            last = self.mask(last)
            raise StepFailed(f"{last[:200]} (exit {p.returncode})" if last else f"command exited with code {p.returncode}")

    def clone(self, url, branch, dest):
        # credential.helper= : a configured store/libsecret helper must never save the injected token
        self.run(["git", "-c", "credential.helper=", "clone", "--depth", "1", "--branch", branch, "--single-branch",
                  "--", auth_url(url, self.token, self.gl), dest])
        if auth_url(url, self.token, self.gl) != url:  # don't leave the token in .git/config (zipped, uploaded, docker context)
            self.run(["git", "-C", dest, "remote", "set-url", "origin", url])

    # --- steps: return success message, raise Skip(msg) or StepFailed(msg)
    def s_prepare(self):
        if os.path.exists(self.F):
            raise StepFailed(f"folder already exists: {self.job['folder_name']}")
        os.mkdir(self.F)
        return f"created {self.job['folder_name']}"

    def s_clone(self):
        repo = os.path.join(self.F, self.job["repo_name"])
        self.clone(self.job["repo_url"], self.job["branch"], repo)
        hc, hc_msg = os.path.join(repo, ".deploy", "healthcheck.sh"), ""
        real = os.path.realpath(repo) + os.sep

        def own(p):  # a regular file of the repo, not a symlink out of it (e.g. deploy.yml -> ~/secret)
            return os.path.isfile(p) and not os.path.islink(p) and os.path.realpath(p).startswith(real)
        if own(hc) and os.path.getsize(hc) <= 256 * 1024:
            os.makedirs(os.path.join(self.F, ".deploy"), exist_ok=True)
            shutil.copy2(hc, os.path.join(self.F, ".deploy", "healthcheck.sh"))
            self.job["healthcheck"], hc_msg = True, " · healthcheck.sh"
            self.log("found .deploy/healthcheck.sh -> copied to <folder>/.deploy/healthcheck.sh")
        ci = os.path.join(repo, ".gitlab-ci.yml")
        if own(ci) and os.path.getsize(ci) <= 256 * 1024:  # the deployer reads SERVICE_NAME / DEV_IMAGE_TAG from it
            shutil.copy2(ci, os.path.join(self.F, ".gitlab-ci.yml"))
            hc_msg += " · .gitlab-ci.yml"
            self.log("found .gitlab-ci.yml -> copied to <folder>/.gitlab-ci.yml")
        found = [n for n in ("deploy.yml", "deploy.yaml") if own(os.path.join(repo, n))]
        if not found:
            self.log("no deploy.yml in repo root (the deployer will use its Settings mapping)")
            return f"cloned {self.job['branch']} into {self.job['repo_name']}{hc_msg}"
        if len(found) > 1:
            raise StepFailed("both deploy.yml and deploy.yaml exist; keep one")
        with open(os.path.join(repo, found[0]), encoding="utf-8", errors="replace") as f:
            text = f.read(65536)
        try:
            m = check_manifest(text)
        except ValueError as e:
            raise StepFailed(f"{found[0]}: {e}")
        with open(os.path.join(self.F, "deploy.yml"), "w", encoding="utf-8") as f:
            f.write(text)
        self.job["deploy_manifest"] = m
        self.log(f"{found[0]}: " + ", ".join(f"{k}={v}" for k, v in m.items()) + " -> copied to <folder>/deploy.yml")
        return f"cloned {self.job['branch']} into {self.job['repo_name']} · deploy.yml: service {m['service']}{hc_msg}"

    def s_build(self):
        repo = os.path.join(self.F, self.job["repo_name"])
        tars, env, msg = self.job.get("preload_tars") or [], self.job.get("env"), ""
        for t in tars:
            if not os.path.isfile(t):
                raise StepFailed(f"preload tar not found: {t}")
            self.run(["docker", "load", "-i", t])
        target, original = None, None
        try:
            if env:
                content = self.secret.get("env") or ""
                root = os.path.realpath(repo)
                raw = os.path.join(repo, env["path"])
                target = os.path.realpath(raw)
                if (os.path.islink(raw) or not target.startswith(root + os.sep)
                        or not os.path.isdir(os.path.dirname(target))):
                    target = None
                    raise StepFailed("env.path: outside the repo")
                if os.path.isfile(target):
                    with open(target, "rb") as f:
                        original = (f.read(), os.stat(target).st_mode & 0o777)
                env["written"] = target
                self.save()  # path (not value) on disk first, so recover_interrupted() can delete it after a kill
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
                os.fchmod(fd, 0o644)  # 644 like the CI heredoc: COPY keeps the mode, a non-root USER must read it
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(content)
                self.log(f"wrote {env['path']} ({len(env['keys'])} keys: {', '.join(env['keys'])})")
                try:
                    with open(os.path.join(repo, ".dockerignore"), encoding="utf-8", errors="replace") as f:
                        if {ln.strip() for ln in f} & {".env", "*.env", "**/.env"}:
                            self.log("WARNING: .dockerignore excludes .env; the image will not contain it")
                except OSError:
                    pass
                msg += f" · .env {len(env['keys'])} keys"
            if self.job["build_command"]:
                self.run(self.job["build_command"], cwd=repo, shell=True)
            df = os.path.join(repo, self.job["dockerfile"])
            if not os.path.isfile(df):
                raise StepFailed(f"Dockerfile not found: {self.job['dockerfile']}")
            self.run(["docker", "build", "-t", self.job["image_tag"], "-f", df, repo])
        finally:
            if target:
                try:
                    if original:
                        with open(target, "wb") as f:
                            f.write(original[0])
                        os.chmod(target, original[1])
                    else:
                        os.remove(target)
                except OSError as e:
                    self.log(f"WARNING: could not clean up {env['path']}: {e}")
            self.secret.pop("env", None)
        if tars:
            msg += f" · preloaded {len(tars)} tar" + ("s" if len(tars) > 1 else "")
        return f"image {self.job['image_tag']} built{msg}"

    def s_save(self):
        tar = os.path.join(self.F, tar_name(self.job))
        self.run(["docker", "save", "-o", tar, self.job["image_tag"]])
        size = os.path.getsize(tar)
        self.job["artifacts"].update(tar=True, tar_size=size)
        return f"saved {os.path.basename(tar)} ({size} bytes)"

    def s_extra_repos(self):
        extras = self.job["extra_repos"]
        if not extras:
            raise Skip("skipped: no extra repos")
        for e in extras:
            self.clone(e["url"], e["branch"], os.path.join(self.F, e["name"]))
        return f"cloned {len(extras)} extra repo(s)"

    def s_zip(self):
        top, zpath, n = self.job["folder_name"], self.F + ".zip", 0
        self.log(f"zipping {top}/ -> {os.path.basename(zpath)} (AES-256)")
        with pyzipper.AESZipFile(zpath, "w", compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as z:
            z.setpassword(self.secret.pop("password").encode())
            z.setencryption(pyzipper.WZ_AES, nbits=256)
            # image tar + what the deployer reads (deploy.yml, .gitlab-ci.yml, healthcheck.sh); repos stay local
            for name in (tar_name(self.job), "deploy.yml", ".gitlab-ci.yml", ".deploy/healthcheck.sh"):
                full = os.path.join(self.F, name)
                if os.path.isfile(full) and not os.path.islink(full):
                    z.write(full, f"{top}/{name}")
                    self.log(f"added {top}/{name}")
                    n += 1
            if not n or not os.path.isfile(os.path.join(self.F, tar_name(self.job))):
                raise StepFailed("image tar missing, nothing to zip")
        size = os.path.getsize(zpath)
        self.job["artifacts"].update(zip=True, zip_size=size)
        return f"{n} files, {size} bytes"

    def s_upload(self):
        u = load_config()["upload"]
        if not self.job["upload_requested"] or not u["enabled"]:
            raise Skip("skipped: upload disabled")
        if not u["host"]:
            raise Skip("skipped: upload not configured")
        zpath, name = self.F + ".zip", self.job["folder_name"] + ".zip"
        total, last = os.path.getsize(zpath) or 1, [-1]

        def progress(done):
            pct = done * 100 // total // 10 * 10
            if pct > last[0]:
                last[0] = pct
                self.log(f"uploaded {pct}% ({done}/{total} bytes)")
        u = {**u, "remote_dir": self.job.get("remote_dir") or u["remote_dir"]}
        d = u["remote_dir"] if u["remote_dir"].startswith("/") else "/" + u["remote_dir"]
        share = "/" + u["share"] if u["protocol"] == Protocol.SMB else ""
        self.log(f"connecting {u['protocol']}://{u['host']}:{u['port']}{share} as {u['username'] or '(none)'}")
        made = []
        with remote(u, made) as (put, _rm):
            for m in made:
                self.log(f"created remote folder {m}")
            self.log(f"remote dir {d} OK, uploading {name}")
            put(zpath, name, progress)
        rp = f"{u['protocol']}://{u['host']}:{u['port']}{share}{posixpath.join(d, name)}"
        self.job["artifacts"]["remote_path"] = rp
        return f"uploaded to {rp}"

    def __call__(self):
        job = self.job
        try:
            job["status"] = JobStatus.RUNNING
            self.save()
            for step in job["steps"]:
                step.update(status=StepStatus.RUNNING, started_at=now_iso())
                self.save()
                self.log(f"==> [{step['name']}] started")
                try:
                    step.update(status=StepStatus.SUCCESS, message=self.mask(getattr(self, "s_" + step["name"])()))
                except Skip as e:
                    step.update(status=StepStatus.SKIPPED, message=str(e))
                except Exception as e:  # StepFailed or anything unexpected: fail the step
                    step.update(status=StepStatus.FAILED, message=self.mask(str(e)) or e.__class__.__name__)
                step["finished_at"] = now_iso()
                msg = step["message"].removeprefix(step["status"] + ": ")
                self.log(f"==> [{step['name']}] {step['status']}: {msg}")
                if step["status"] == StepStatus.FAILED:
                    job["error"] = step["message"]
                    break
                self.save()
        except Exception as e:
            job["error"] = job["error"] or self.mask(f"internal error: {e}")
        finally:
            self.secret.clear()
            job["status"] = JobStatus.FAILED if job["error"] else JobStatus.SUCCESS
            job["finished_at"] = now_iso()
            self.log("==> JOB SUCCESS" if job["status"] == JobStatus.SUCCESS else f"==> JOB FAILED: {job['error']}")
            self.logf.close()
            self.save()  # json last: SSE sees final log lines before final status
