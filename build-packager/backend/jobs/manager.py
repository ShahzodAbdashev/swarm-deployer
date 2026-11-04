"""Recovery of jobs interrupted by a restart."""
import os
from datetime import datetime

from backend.core.constants import DONE
from backend.core.enums import JobStatus, StepStatus
from backend.jobs.store import all_jobs, job_path
from backend.utils.dates import now_iso
from backend.utils.files import write_json


def recover_interrupted():
    for j in all_jobs():
        if j["status"] not in DONE:
            j.update(status=JobStatus.FAILED, error="interrupted (server restart)", finished_at=now_iso())
            for s in j["steps"]:
                if s["status"] == StepStatus.RUNNING:
                    s.update(status=StepStatus.FAILED, message="interrupted (server restart)", finished_at=now_iso())
            written = (j.get("env") or {}).get("written")
            if written:  # never leave a plaintext .env in the workspace after a kill during build
                try:
                    os.remove(written)
                except OSError:
                    pass
            with open(job_path(j["id"], "log"), "a") as f:
                f.write(f"[{datetime.now():%H:%M:%S}] ==> JOB FAILED: interrupted (server restart)\n")
            write_json(job_path(j["id"]), j)
