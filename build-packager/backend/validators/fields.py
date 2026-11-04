"""Field validators (HTTP 400 on bad input)."""
import re

from backend.core.errors import bad
from backend.core.patterns import BRANCH_RE, PROJECT_RE, URL_RE


def valid_branch(b):
    return bool(b and BRANCH_RE.match(b) and ".." not in b and "//" not in b
                and not b.endswith("/") and not b.endswith(".lock"))


def valid_url(u):
    return bool(u and len(u) <= 500 and not u.startswith("-") and URL_RE.match(u))


def url_basename(u):
    base = re.split(r"[/:]", u.rstrip("/"))[-1]
    return base[:-4] if base.endswith(".git") else base


def valid_project(p):
    return bool(p and PROJECT_RE.match(p) and ".." not in p.split("/"))


def clean_remote_dir(d, field="remote_dir"):
    """Full absolute path, no '..', no control chars (CR/LF would inject FTP commands). Returns normalized path."""
    d = (d or "").strip()
    if not d.startswith("/"):
        bad(f"{field}: must be a full path starting with /")
    if any(ord(ch) < 32 for ch in d) or ".." in d.split("/") or len(d) > 1024:
        bad(f"{field}: invalid path")
    return "/" + "/".join(p for p in d.split("/") if p and p != ".")
