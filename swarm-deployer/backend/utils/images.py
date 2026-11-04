"""Docker image reference helpers and package file name parsing."""
from backend.core.patterns import PKG_FILE_RE, TARZIP_RE


def strip_digest(image):
    return (image or "").split("@", 1)[0] or None


def registry_mode(t, repo):
    """AD-2: the target has a registry and the image repo lives under it."""
    url = ((t or {}).get("registry") or {}).get("url")
    return bool(url) and bool(repo) and repo.startswith(url + "/")


def split_ref(ref):
    """'reg:5000/a/b:tag@sha256:..' -> (repo, tag|None, digest|None)."""
    ref, _, dg = (ref or "").partition("@")
    i = ref.rfind(":")
    if i > ref.rfind("/"):
        return ref[:i], ref[i + 1:], dg or None
    return ref, None, dg or None


def repo_of(ref):
    return split_ref(ref)[0]


def same_image(task_img, want):
    return task_img == want if "@" in (want or "") else strip_digest(task_img) == want


def parse_pkg(name):
    """Package file name -> (service, ts|None, 'packager'|'tarzip') or None (SPEC §11.1)."""
    m = PKG_FILE_RE.fullmatch(name or "")
    if m:
        return m["service"], m["ts"], "packager"
    m = TARZIP_RE.fullmatch(name or "")
    if m:
        return m["service"], m["ts"], "tarzip"
    return None
