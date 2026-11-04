"""Upload (file server) settings validation."""
from backend.core.constants import PROTOCOLS
from backend.core.enums import Protocol
from backend.core.errors import bad
from backend.core.patterns import DOMAIN_RE, SHARE_RE
from backend.validators.fields import clean_remote_dir


def check_upload(new):
    """Validate a full upload dict (put_upload and the .env import). Returns it cleaned or raises 400."""
    if new["protocol"] not in PROTOCOLS:
        bad("protocol: must be sftp, ftp, ftps or smb")
    if not isinstance(new["port"], int) or not 1 <= new["port"] <= 65535:
        bad("port: must be 1-65535")
    new["host"] = new["host"].strip()
    if new["enabled"] and not new["host"]:
        bad("host: required when upload is enabled")
    if not new["remote_dir"].strip():
        bad("remote_dir: required")
    new["remote_dir"] = clean_remote_dir(new["remote_dir"])
    check_smb(new)
    return new


def check_smb(u):
    if u["protocol"] == Protocol.SMB and u["host"] and not SHARE_RE.match(u.get("share") or ""):
        bad("share: required for SMB")
    if u.get("domain") and not DOMAIN_RE.match(u["domain"]):
        bad("domain: letters, digits, . _ - only")
