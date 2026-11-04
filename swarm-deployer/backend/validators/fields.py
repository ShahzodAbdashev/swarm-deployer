"""Field validators: raise HTTP 400 with a clear message."""
from backend.core.errors import bad
from backend.core.patterns import GL_URL_RE, HOST_RE


def v_str(v, field, maxlen=1024):
    if not isinstance(v, str):
        bad(f"{field}: must be a string")
    if len(v) > maxlen or any(ord(c) < 32 for c in v):
        bad(f"{field}: invalid value")
    return v


def v_re(v, field, rx, msg="invalid value"):
    if not isinstance(v, str) or not rx.fullmatch(v):
        bad(f"{field}: {msg}")
    return v


def v_int(v, field, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        bad(f"{field}: must be an integer {lo}-{hi}")
    return v


def v_bool(v, field):
    if not isinstance(v, bool):
        bad(f"{field}: must be true or false")
    return v


def clean_remote_dir(d, field="remote_dir"):
    """Same rule as Build Packager: absolute, no '..', no control chars, <=1024. Returns normalized path."""
    if not isinstance(d, str):
        bad(f"{field}: must be a string")
    d = d.strip()
    if not d.startswith("/"):
        bad(f"{field}: must be a full path starting with /")
    if any(ord(ch) < 32 for ch in d) or ".." in d.split("/") or len(d) > 1024:
        bad(f"{field}: invalid path")
    return "/" + "/".join(p for p in d.split("/") if p and p != ".")


def v_host(v, field):
    if not isinstance(v, str) or not 1 <= len(v.strip()) <= 253 or not HOST_RE.fullmatch(v.strip()):
        bad(f"{field}: invalid host")
    return v.strip()


def v_gl_url(v, field="url"):
    v = v_str(v, field, 200).strip().rstrip("/")
    return v_re(v, field, GL_URL_RE, "must be an http(s) URL like http://192.168.33.175")
