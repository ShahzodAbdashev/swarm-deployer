"""File server for listing and downloading packages: SFTP, or a folder on this computer ("local")."""
import os
import stat
from contextlib import contextmanager

import paramiko
import pyzipper

from backend.core.errors import bad


@contextmanager
def _sftp(u):
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())  # same as Build Packager's upload side
    try:
        no_creds = not u["password"] and not u["private_key_path"]
        ssh.connect(u["host"], int(u["port"]), username=u["username"] or None, password=u["password"] or None,
                    key_filename=u["private_key_path"] or None, timeout=15, banner_timeout=15,
                    auth_timeout=15, allow_agent=no_creds, look_for_keys=no_creds)
        sftp = ssh.open_sftp()
        sftp.get_channel().settimeout(60)
        yield sftp
    finally:
        ssh.close()


def _inside(u, path):
    """Local mode: an absolute path inside the configured folder (no browsing elsewhere on this computer)."""
    root = os.path.realpath(u["remote_dir"])
    real = os.path.realpath(path)
    if real != root and not real.startswith(root.rstrip("/") + "/"):
        raise PermissionError(f"{path} is outside the local folder {u['remote_dir']}")
    return real


@contextmanager
def fileserver(u):
    """Yields (ls(path) -> [(name, is_dir, size, mtime)], get(path, local, cb(done, total)) -> size)."""
    if u.get("protocol") == "local":
        def ls(path):
            out = []
            with os.scandir(_inside(u, path)) as it:
                for e in it:
                    st = e.stat()
                    out.append((e.name, e.is_dir(), None if e.is_dir() else st.st_size, st.st_mtime))
            return out

        def get(path, local, cb):
            src = _inside(u, path)
            total, done = os.path.getsize(src), 0
            with open(src, "rb") as f, open(local, "wb") as dst:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    dst.write(chunk)
                    done += len(chunk)
                    cb(done, total)
            return done
        yield ls, get
        return
    with _sftp(u) as sftp:
        def ls(path):
            return [(a.filename, stat.S_ISDIR(a.st_mode or 0), a.st_size, a.st_mtime) for a in sftp.listdir_attr(path)]

        def get(path, local, cb):
            total = sftp.stat(path).st_size
            sftp.get(path, local, callback=lambda done, _t: cb(done, total))
            return total
        yield ls, get


@contextmanager
def _sftp_open(u, path):
    with _sftp(u) as sftp, sftp.open(path, "rb") as f:
        yield f


def read_zip_member(u, path, name, password, limit=256 * 1024):
    """One small file (e.g. .gitlab-ci.yml) out of a zip on the file server, read in place: only the zip's
    directory and that member go over the wire. None when the zip has no such member (top level or one folder
    deep). Raises RuntimeError on a wrong password (AES or ZipCrypto)."""
    with (open(_inside(u, path), "rb") if u.get("protocol") == "local" else _sftp_open(u, path)) as f, \
            pyzipper.AESZipFile(f) as z:
        m = next((i for i in z.infolist() if i.filename.count("/") <= 1
                  and (i.filename == name or i.filename.endswith("/" + name))), None)
        if not m or m.file_size > limit:
            return None
        return z.read(m, pwd=password.encode())

def need_file_server(cfg):
    fs = cfg["file_server"]
    if not (fs["remote_dir"] if fs.get("protocol") == "local" else fs["host"]):
        bad("file_server: not configured")
    return fs
