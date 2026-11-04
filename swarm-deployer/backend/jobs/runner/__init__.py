"""Runner: executes one deploy/rollback job phase by phase over SSH (auto rollback on failure).

base.py      RunnerBase     state + helpers
package.py   PackagePhases  fetch, extract
deploy.py    DeployPhases   connect .. cleanup
rollback.py  RollbackMixin  rollback, registry repair, recovery"""
import os
import shutil

from backend.core.constants import DONE
from backend.core.enums import JobKind, JobStatus, Phase, PhaseStatus
from backend.core.errors import Fail, Skip
from backend.jobs.runner.base import RunnerBase
from backend.jobs.runner.deploy import DeployPhases
from backend.jobs.runner.package import PackagePhases
from backend.jobs.runner.rollback import RollbackMixin
from backend.jobs.store import busy, busy_key, busy_lock
from backend.utils.dates import now_iso


class Runner(PackagePhases, DeployPhases, RollbackMixin, RunnerBase):
    def __call__(self):
        job, failed = self.job, False
        try:
            job["status"] = JobStatus.RUNNING
            self.save()
            for ph in job["phases"]:
                n = ph["name"]
                if failed and n != "cleanup":
                    ph.update(status=PhaseStatus.SKIPPED, message="skipped: earlier phase failed")
                    self.log(f"==> [{n}] skipped: earlier phase failed")
                    continue
                ph.update(status=PhaseStatus.RUNNING, started_at=now_iso())
                self.save()
                self.log(f"==> [{n}] started")
                suffix = ""
                try:
                    ph.update(status=PhaseStatus.SUCCESS, message=getattr(self, "p_" + n)())
                except Skip as e:
                    ph.update(status=PhaseStatus.SKIPPED, message=str(e))
                except Exception as e:
                    msg = self.mask(str(e) if isinstance(e, Fail) else f"{type(e).__name__}: {e}")
                    ph.update(status=PhaseStatus.FAILED, message=" ".join(msg.split())[:300])
                    if n in (Phase.TAG, Phase.DEPLOY, Phase.VERIFY):
                        suffix = self.auto_rollback()
                ph["finished_at"] = now_iso()
                self.log(f"==> [{n}] {ph['status']}: {ph['message'].removeprefix(ph['status'] + ': ')}")
                if ph["status"] == PhaseStatus.FAILED and not failed:
                    failed = True
                    job["error"] = f"{n}: {ph['message']}{suffix}"
                self.save()
        except Exception as e:
            job["error"] = job["error"] or f"internal error: {e}"
        finally:
            self.finish()

    def finish(self):
        job = self.job
        if job["error"]:  # internal / recovery errors: exception text may carry a secret
            job["error"] = self.mask(job["error"])
        for ph in job["phases"]:
            if ph.get("message"):
                ph["message"] = self.mask(ph["message"])
        self.secret.clear()
        for sh in self.all_hosts() if self.sh else self.nodes:
            try:
                sh.close()
            except Exception:
                pass
        if job["kind"] == JobKind.DEPLOY and os.path.isdir(self.work) and not any(
                p["name"] == Phase.CLEANUP and p["status"] in DONE for p in job["phases"]):
            shutil.rmtree(self.work, ignore_errors=True)
        job["status"] = JobStatus.FAILED if job["error"] else JobStatus.SUCCESS
        job["finished_at"] = now_iso()
        self.log("==> JOB SUCCESS" if job["status"] == JobStatus.SUCCESS else f"==> JOB FAILED: {job['error']}")
        self.logf.close()
        self.save()  # json last: SSE sees final log lines before final status
        with busy_lock:
            busy.discard(busy_key(job))
