"""config.json: load with defaults and locked read-modify-write."""
import json
import threading

from backend.core.constants import DEFAULT_UPLOAD
from backend.core.paths import CONFIG
from backend.utils.files import write_json


cfg_lock = threading.Lock()


def load_config():
    cfg = {"github_token": None, "github_login": None, "github_avatar_url": None,
           "gitlab_url": "", "gitlab_token": None, "gitlab_token_url": "", "gitlab_refresh_token": None,
           "gitlab_expires_at": None, "gitlab_login": None, "gitlab_avatar_url": None, "gitlab_method": None,
           "gitlab_redirect_uri": "", "gitlab_client_id": "", "gitlab_client_secret": "",
           "env_import_sha": "", "env_import_at": None, "upload": dict(DEFAULT_UPLOAD)}
    try:
        with open(CONFIG) as f:
            disk = json.load(f)
        cfg.update({k: v for k, v in disk.items() if k != "upload"})
        cfg["upload"].update(disk.get("upload") or {})
    except (OSError, ValueError):
        pass
    return cfg


def update_config(fn):
    with cfg_lock:
        cfg = load_config()
        fn(cfg)
        write_json(CONFIG, cfg, 0o600)
        return cfg
