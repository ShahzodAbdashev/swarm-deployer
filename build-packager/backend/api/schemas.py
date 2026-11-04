"""Request bodies (pydantic models)."""
from pydantic import BaseModel


class TokenIn(BaseModel):
    token: str = ""


class DeviceIn(BaseModel):
    device_code: str = ""


class UploadIn(BaseModel):
    enabled: bool | None = None
    protocol: str | None = None
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = None
    remote_dir: str | None = None
    private_key_path: str | None = None
    domain: str | None = None
    share: str | None = None


class ExtraRepoIn(BaseModel):
    url: str = ""
    branch: str = "main"
    name: str | None = None


class EnvIn(BaseModel):
    content: str = ""
    path: str = ".env"
    source: str = "paste"  # paste | file | gitlab (label only)


class GitlabTokenIn(BaseModel):
    token: str = ""
    url: str | None = None


class GitlabCfgIn(BaseModel):
    client_id: str | None = None
    client_secret: str | None = None


class EnvPreviewIn(BaseModel):
    repo_url: str = ""
    branch: str = ""
    job: str | None = None


class ContentIn(BaseModel):
    content: str = ""


class JobIn(BaseModel):
    service: str = ""
    repo_url: str = ""
    branch: str = ""
    dockerfile: str | None = "Dockerfile"
    build_command: str | None = ""
    extra_repos: list[ExtraRepoIn] = []
    password: str = ""
    password_confirm: str = ""
    upload: bool = True
    remote_dir: str | None = None  # per-build override of the settings' remote path
    env: EnvIn | None = None
    preload_tars: list[str] = []
