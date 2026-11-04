"""SFTP file server client for listing and downloading packages."""
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


@contextmanager
def fileserver(u):
    """Yields (ls(path) -> [(name, is_dir, size, mtime)], get(path, local, cb(done, total)) -> size)."""
    with _sftp(u) as sftp:
        def ls(path):
            return [(a.filename, stat.S_ISDIR(a.st_mode or 0), a.st_size, a.st_mtime) for a in sftp.listdir_attr(path)]

        def get(path, local, cb):
            total = sftp.stat(path).st_size
            sftp.get(path, local, callback=lambda done, _t: cb(done, total))
            return total
        yield ls, get


def read_zip_member(u, path, name, password, limit=256 * 1024):
    """One small file (e.g. .gitlab-ci.yml) out of a zip on the file server, read in place: only the zip's
    directory and that member go over the wire. None when the zip has no such member (top level or one folder
    deep). Raises RuntimeError on a wrong password (AES or ZipCrypto)."""
    with _sftp(u) as sftp, sftp.open(path, "rb") as f, pyzipper.AESZipFile(f) as z:
        m = next((i for i in z.infolist() if i.filename.count("/") <= 1
                  and (i.filename == name or i.filename.endswith("/" + name))), None)
        if not m or m.file_size > limit:
            return None
        return z.read(m, pwd=password.encode())

def need_file_server(cfg):
    fs = cfg["file_server"]
    if not fs["host"]:
        bad("file_server: not configured")
    return fs
