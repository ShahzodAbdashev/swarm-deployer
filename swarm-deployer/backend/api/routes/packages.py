"""Packages in a target's packages folder."""
import posixpath
from datetime import datetime

from fastapi import APIRouter

from backend.config.store import load_config
from backend.core.errors import bad
from backend.jobs.store import known_services
from backend.remote.fileserver import fileserver, packages_target
from backend.utils.dates import mtime_key, ts_iso
from backend.utils.images import parse_pkg
from backend.validators.fields import clean_remote_dir

router = APIRouter()


@router.get("/api/packages")
def list_packages(path: str | None = None, target: str | None = None):
    cfg = load_config()
    t = packages_target(cfg, target)
    path = clean_remote_dir(path if path is not None else t["packages_dir"], "path")
    try:
        with fileserver(t) as (ls, _get):
            entries = ls(path)
    except Exception as e:
        bad(f"target {t['id']}: {type(e).__name__}: {e}", 502)
    mapped = {m["package"] for m in known_services(cfg)}  # deployed before
    dirs, other, groups = [], [], {}
    keys = {}
    for name, is_dir, size, mtime in entries:
        if name.startswith("."):
            continue
        if is_dir:
            dirs.append(name)
            continue
        pp = parse_pkg(name)
        if not pp:
            other.append(name)
            continue
        svc, ts, fmt = pp
        mod = datetime.fromtimestamp(mtime).isoformat(timespec="seconds") if mtime else None
        full = posixpath.join(path, name)
        keys[full] = ts or mtime_key(mtime)
        groups.setdefault(svc, []).append(
            {"name": name, "path": full, "ts": ts, "format": fmt, "created_at": ts_iso(ts) if ts else mod,
             "modified_at": mod, "size": size})
    out = []
    for svc, pk in groups.items():
        pk.sort(key=lambda p: keys[p["path"]], reverse=True)
        out.append({"service": svc, "mapped": svc in mapped, "deployable": svc in mapped,
                    "packages": pk})
    out.sort(key=lambda g: (g["mapped"], keys[g["packages"][0]["path"]]), reverse=True)  # deployable groups first
    return {"target": t["id"], "path": path, "dirs": sorted(dirs), "groups": out, "other": sorted(other)}
