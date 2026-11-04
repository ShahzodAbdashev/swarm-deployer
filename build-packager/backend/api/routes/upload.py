"""Upload settings and connection test."""
import tempfile
import uuid

from fastapi import APIRouter

from backend.api.schemas import UploadIn
from backend.config.store import load_config, update_config
from backend.core.constants import PROTOCOLS
from backend.core.enums import Protocol
from backend.core.errors import bad
from backend.remote.upload import remote
from backend.validators.fields import clean_remote_dir
from backend.validators.upload import check_smb, check_upload

router = APIRouter()


def public_upload(u):
    return {**{k: v for k, v in u.items() if k != "password"}, "has_password": bool(u["password"])}


@router.get("/api/config/upload")
def get_upload():
    return public_upload(load_config()["upload"])


@router.put("/api/config/upload")
def put_upload(body: UploadIn):
    new = check_upload({**load_config()["upload"], **body.model_dump(exclude_none=True)})
    return public_upload(update_config(lambda c: c.update(upload=new))["upload"])


@router.post("/api/config/upload/test")
def test_upload(body: UploadIn | None = None):
    """Tests the saved settings, overridden by any fields in the body (so the form can be tested unsaved).
    Creates the remote path if missing and proves write access with a probe file."""
    over = body.model_dump(exclude_none=True) if body else {}
    if not over.get("password"):
        over.pop("password", None)  # blank = keep saved password
    u = {**load_config()["upload"], **over}
    u["host"] = (u["host"] or "").strip()
    if not u["host"]:
        bad("host: required")
    if u["protocol"] not in PROTOCOLS:
        bad("protocol: must be sftp, ftp, ftps or smb")
    u["remote_dir"] = clean_remote_dir(u["remote_dir"])
    check_smb(u)
    made, probe = [], f".bp_write_test_{uuid.uuid4().hex[:8]}"
    try:
        with remote(u, made) as (put, rm):
            with tempfile.NamedTemporaryFile() as f:
                f.write(b"ok")
                f.flush()
                put(f.name, probe, lambda _d: None)
            rm(probe)
        where = u["share"] + u["remote_dir"] if u["protocol"] == Protocol.SMB else u["remote_dir"]
        msg = f"Connected to {u['host']}:{u['port']} · {where} is writable"
        if made:
            msg += " · created " + ", ".join(made)
        return {"ok": True, "message": msg, "created": made}
    except Exception as e:
        msg = f"{e.__class__.__name__}: {e}"
        if u.get("password"):
            msg = msg.replace(u["password"], "***")
        if made:
            msg += " (created " + ", ".join(made) + " before failing)"
        return {"ok": False, "message": msg, "created": made}
