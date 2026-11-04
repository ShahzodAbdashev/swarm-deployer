"""Mapped services and their backups."""
import posixpath
import re

from fastapi import APIRouter, HTTPException

from backend.config.store import find, load_config
from backend.core.errors import bad
from backend.core.patterns import TS_RE
from backend.jobs.store import known_services
from backend.remote.ssh import connect_target
from backend.remote.swarm import need_mapping, services_rows

router = APIRouter()


@router.get("/api/services")
def list_services():
    cfg = load_config()
    return services_rows(known_services(cfg), cfg)


@router.get("/api/services/{package}")
def get_service(package: str):
    cfg = load_config()
    return services_rows([need_mapping(cfg, package)], cfg)[0]


@router.get("/api/services/{package}/backups")
def list_backups(package: str):
    """New layout B/<svc>/<ts> (id <svc>_<ts>), then legacy B/<svc>_<ts>, newest first (AD-5)."""
    cfg = load_config()
    m = need_mapping(cfg, package)
    t = find(cfg["targets"], "id", m["target"])
    svc, B = m["swarm_service"], t["backup_dir"]
    rx = re.compile(re.escape(svc) + r"_\d{8}_\d{6}")
    try:
        sh = connect_target(t)
    except Exception as e:
        bad(f"target: {type(e).__name__}: {e}", 502)
    out = []
    try:
        def names(d, ok):
            try:
                return [n for n in sh.sftp().listdir(d) if ok(n)]
            except FileNotFoundError:
                return []
        dirs = [(n, posixpath.join(B, svc, n), "new") for n in names(posixpath.join(B, svc), TS_RE.fullmatch)]
        dirs += [(n[-15:], posixpath.join(B, n), "legacy") for n in names(B, rx.fullmatch)]
        for ts, d, layout in sorted(dirs, key=lambda x: x[0], reverse=True):
            try:
                meta = sh.read_json(posixpath.join(d, "meta.json"))
            except (OSError, ValueError):
                continue
            bt = meta.get("backup_tag")
            present = bool(bt) and sh.run(sh.D + ["image", "inspect", "--format", "{{.Id}}", bt], quiet=True)[0] == 0
            dg = meta.get("backup_digest") or meta.get("previous_digest")
            out.append({"id": f"{svc}_{ts}", "created_at": meta.get("created_at"),
                        "previous_image": meta.get("previous_image"), "backup_tag": bt, "tag_present": present,
                        "has_image_tar": bool(meta.get("has_image_tar")), "job_id": meta.get("job_id"), "dir": d,
                        "digest": dg, "in_registry": bool(meta.get("registry") and dg), "layout": layout})
    except HTTPException:
        raise
    except Exception as e:
        bad(f"target: {type(e).__name__}: {e}", 502)
    finally:
        sh.close()
    return out
