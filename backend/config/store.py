"""config.json: load with defaults, locked read-modify-write, secret-free public view."""
import copy
import json
import os
import threading

from backend.core.constants import DEFAULTS, SECRET_KEYS
from backend.core.paths import CONFIG
from backend.utils.files import write_json


cfg_lock = threading.Lock()


def load_config():
    cfg = copy.deepcopy(DEFAULTS)
    try:
        with open(CONFIG) as f:
            disk = json.load(f)
        for k in ("file_server", "options", "gitlab", "env_import"):  # known keys only: drops removed settings
            cfg[k].update({f: v for f, v in (disk.get(k) or {}).items() if f in DEFAULTS[k]})
        cfg["targets"] = disk.get("targets") or []
        for t in cfg["targets"]:  # targets saved before registries existed
            t["registry"] = {"url": "", "username": "", "password": "", **(t.get("registry") or {})}
    except (OSError, ValueError):
        pass
    return cfg


def update_config(fn):
    with cfg_lock:
        cfg = load_config()
        out = fn(cfg)
        write_json(CONFIG, cfg, 0o600)
        os.chmod(CONFIG, 0o600)
        return out


def find(items, key, value):
    return next((x for x in items if x.get(key) == value), None)


def public(obj):
    """Copy of a config part with every secret (SECRET_KEYS) replaced by has_<key>."""
    if isinstance(obj, list):
        return [public(x) for x in obj]
    if isinstance(obj, dict):
        out = {k: public(v) for k, v in obj.items() if k not in SECRET_KEYS}
        for k in SECRET_KEYS:
            if k in obj:
                out["has_" + k] = bool(obj[k])
        return out
    return obj
