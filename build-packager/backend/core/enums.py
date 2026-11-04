"""Enumerations of the string values stored in jobs and settings.

StrEnum members are plain strings: JobStatus.SUCCESS == "success", json.dumps writes "success", and job files
written before these enums existed load unchanged."""
from enum import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class StepStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class Step(StrEnum):
    """Build steps in run order; Runner.s_<step> implements each."""
    PREPARE = "prepare"
    CLONE = "clone"
    BUILD = "build"
    SAVE = "save"
    EXTRA_REPOS = "extra_repos"
    ZIP = "zip"
    UPLOAD = "upload"


class Protocol(StrEnum):
    SFTP = "sftp"
    FTP = "ftp"
    FTPS = "ftps"
    SMB = "smb"


class GitlabMethod(StrEnum):
    """How the GitLab session was created."""
    PAT = "pat"
    OAUTH = "oauth"
