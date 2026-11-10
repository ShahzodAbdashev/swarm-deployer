"""Packages on the target itself: its packages folder, over the target's own SSH login."""
import stat
from contextlib import contextmanager

import pyzipper

from backend.config.store import find
from backend.core.errors import bad
from backend.remote.ssh import connect_target


def packages_target(cfg, tid=None):
    """The target the packages come from (and go to): tid, else the only target. Needs its packages folder."""
    ts = cfg["targets"]
    if not ts:
        bad("target: add a target server in Settings")
    t = find(ts, "id", tid) if tid else (ts[0] if len(ts) == 1 else None)
    if not t:
        bad(f"target: {tid} not found" if tid else "target: choose the target server")
    if not t.get("packages_dir"):
        bad(f"target {t['id']}: set its packages folder in Settings → Target servers")
    return t


@contextmanager
def fileserver(t):
    """Yields (ls(path) -> [(name, is_dir, size, mtime)], get(path, local, cb(done, total)) -> size)."""
    sh = connect_target(t)  # the target's own login and host key policy
    try:
        sftp = sh.sftp()

        def ls(path):
            return [(a.filename, stat.S_ISDIR(a.st_mode or 0), a.st_size, a.st_mtime) for a in sftp.listdir_attr(path)]

        def get(path, local, cb):
            total = sftp.stat(path).st_size
            sftp.get(path, local, callback=lambda done, _t: cb(done, total))
            return total
        yield ls, get
    finally:
        sh.close()


def read_zip_member(t, path, name, password, limit=256 * 1024):
    """One small file (e.g. .gitlab-ci.yml) out of a zip on the target, read in place: only the zip's directory and
    that member go over the wire. None when the zip has no such member (top level or one folder deep). Raises
    RuntimeError on a wrong password (AES or ZipCrypto)."""
    sh = connect_target(t)
    try:
        with sh.sftp().open(path, "rb") as f, pyzipper.AESZipFile(f) as z:
            m = next((i for i in z.infolist() if i.filename.count("/") <= 1
                      and (i.filename == name or i.filename.endswith("/" + name))), None)
            if not m or m.file_size > limit:
                return None
            return z.read(m, pwd=password.encode())
    finally:
        sh.close()
