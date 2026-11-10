"""Shared state and helpers: logging, progress, docker/registry helpers, health wait, masking."""
import os
import re
import threading
import time
from datetime import datetime

from backend.config.store import find
from backend.core.enums import RollbackState
from backend.core.errors import Fail
from backend.core.paths import WORK
from backend.jobs.store import job_path
from backend.remote.swarm import running, service_tasks
from backend.utils.files import write_json
from backend.utils.images import repo_of, same_image
from backend.utils.text import jparse, last_line


class RunnerBase:
    def __init__(self, job, cfg, password=None):
        self.job, self.cfg = job, cfg
        self.m = {"health_url": job.get("health_url") or "", "create_if_missing": False}  # picked per deploy
        self.t = find(cfg["targets"], "id", job["target"]) if job["target"] else None
        if job["target"] and not self.t:
            raise KeyError(f"target {job['target']} no longer configured")
        self.opt = cfg["options"]
        self.secret = {"password": password}
        self.masks = [s for s in [password, cfg["gitlab"]["token"],
                                  *[x for t in cfg["targets"] for x in
                                    [t["password"], (t.get("registry") or {}).get("password"),
                                     *[n.get("password") for n in t["extra_nodes"]]]]] if s]
        self.masks.sort(key=len, reverse=True)
        self.work = os.path.join(WORK, job["id"])
        self.logf = open(job_path(job["id"], "log"), "a", encoding="utf-8")
        self.log_lock = threading.Lock()
        self.sh, self.nodes = None, []
        self.touched, self.swarm_auto, self.old_tasks = False, False, set()
        self.local_tar = None
        self.prev_id = None  # image ID previous_image pointed at before this job (from backup)


    # --- plumbing
    def save(self):
        write_json(job_path(self.job["id"]), self.job)

    def log(self, text):
        for s in self.masks:
            text = text.replace(s, "***")
        stamp = datetime.now().strftime("%H:%M:%S")
        with self.log_lock:
            for line in str(text).replace("\r", "\n").split("\n"):
                if line.strip():
                    self.logf.write(f"[{stamp}] {line}\n")
            self.logf.flush()

    def progress(self, verb):
        last = [-1]

        def cb(done, total):
            pct = done * 100 // (total or 1) // 10 * 10 if total else 0
            if pct > last[0]:
                last[0] = pct
                self.log(f"{verb} {pct}% ({done}/{total or '?'} bytes)")
        return cb


    @property
    def D(self):
        return self.sh.D

    def all_hosts(self):
        return [self.sh] + self.nodes


    # --- service state
    def poll(self):
        """(update_state, update_message, desired, running_tasks)"""
        svc, D = self.job["swarm_service"], self.D
        _, o1 = self.sh.run(D + ["service", "inspect", "--format", "{{json .UpdateStatus}}", svc], quiet=True)
        us = jparse(o1) or {}
        _, o2 = self.sh.run(D + ["service", "inspect", "--format", "{{json .Spec.Mode}}", svc], quiet=True)
        mode = jparse(o2) or {}
        tasks = service_tasks(self.sh, svc)
        desired = (mode.get("Replicated") or {}).get("Replicas")
        if desired is None:
            desired = len(tasks)
        return us.get("State"), us.get("Message", ""), desired, running(tasks)

    def wait_on(self, image, want_state=None):
        """Wait until every desired task runs `image` (rollback waits). True when converged."""
        deadline, last = time.monotonic() + self.opt["converge_timeout"], None
        while True:
            state, _msg, desired, run = self.poll()
            ok_img = [t for t in run if same_image(t.get("Image"), image)]
            s = f"[rollback] update_state={state or 'none'} running={len(run)}/{desired} (on {image}: {len(ok_img)})"
            if s != last:
                self.log(s)
                last = s
            state_ok = state == want_state if want_state else state not in ("updating", RollbackState.STARTED)
            if state_ok and desired and len(run) == desired == len(ok_img):
                return True
            if time.monotonic() > deadline:
                return False
            time.sleep(2)


    # --- registry / helpers (SPEC §11.6)
    @property
    def R(self):
        return (self.t.get("registry") or {}) if self.job.get("registry") and self.t else None

    def job_dir(self):
        return self.job["artifacts"].get("job_dir")

    def prev_ref(self):
        j = self.job
        if j.get("previous_digest"):
            return f"{repo_of(j['previous_image'])}@{j['previous_digest']}"
        return j["previous_image"]

    def image_id(self, sh, ref, quiet=False):
        code, out = sh.run(sh.D + ["image", "inspect", "--format", "{{.Id}}", ref], quiet=quiet)
        return last_line(out) if code == 0 else None

    def push(self, ref):
        """Record first (recover() must know a push started), then push. Returns the pushed digest."""
        j = self.job
        if ref not in j["pushed"]:
            j["pushed"].append(ref)
            self.save()
        out = self.sh.check(self.D + ["push", ref], timeout=1800, what="docker push")
        found = re.findall(r"digest: (sha256:[0-9a-f]{64})", out)
        if not found:
            raise Fail(f"docker push {ref}: no digest in output")
        self.log(f"pushed {ref} -> {found[-1]}")
        return found[-1]

    def registry_login(self, sh):
        R = self.R
        self.log(f"registry {R['url']}: logging in as {R['username']} (password via stdin)")
        code, out = sh.run(sh.D + ["login", "--username", R["username"], "--password-stdin", R["url"]],
                           stdin=R["password"])
        if code:
            raise Fail(f"registry login failed: {last_line(out)}")

    def health_wait(self, url):
        deadline, n = time.monotonic() + self.opt["health_timeout"], 0
        while True:
            code, _ = self.sh.run(["wget", "-q", "-O", "/dev/null", "-T", "5", url], timeout=15, quiet=n > 0)
            n += 1
            if code == 0:
                self.log(f"health check OK: {url} (attempt {n})")
                return True
            if time.monotonic() > deadline:
                return False
            time.sleep(2)

    def mask(self, s):
        for m in self.masks:
            s = s.replace(m, "***")
        return s
