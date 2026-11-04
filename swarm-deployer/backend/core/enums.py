"""Enumerations of the string values stored in jobs and settings.

StrEnum members are plain strings: JobStatus.SUCCESS == "success", json.dumps writes "success", and job files
written before these enums existed load unchanged."""
from enum import StrEnum


class JobKind(StrEnum):
    DEPLOY = "deploy"
    ROLLBACK = "rollback"


class JobStatus(StrEnum):
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class PhaseStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class Phase(StrEnum):
    FETCH = "fetch"
    EXTRACT = "extract"
    CONNECT = "connect"
    TRANSFER = "transfer"
    BACKUP = "backup"
    LOAD = "load"
    TAG = "tag"
    DEPLOY = "deploy"
    VERIFY = "verify"
    CLEANUP = "cleanup"


class RollbackState(StrEnum):
    STARTED = "rollback_started"
    PAUSED = "rollback_paused"
    COMPLETED = "rollback_completed"


class DeployMode(StrEnum):
    UPDATE = "update"   # service exists: docker service update
    CREATE = "create"   # create_if_missing: docker service create


class KeyPolicy(StrEnum):
    """SSH host key policy of a target (remote.ssh.HostKeyPolicy implements it)."""
    AUTO_ADD = "auto_add"
    WARN = "warn"
    REJECT = "reject"
