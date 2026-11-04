"""Upload clients (SFTP/FTP/FTPS/SMB) with atomic .part rename."""
import ftplib
import posixpath
from contextlib import contextmanager

import paramiko
import smbclient

from backend.core.enums import Protocol


def staged(send, mv, rm):
    """Upload as <name>.part, rename at the end (the deployer's watch never sees a half-written zip)."""
    def put(local, name, cb):
        part = name + ".part"
        try:
            send(local, part, cb)
            mv(part, name)
        except BaseException:
            try:
                rm(part)
            except Exception:
                pass
            raise
    return put


@contextmanager
def remote(u, created=None):
    """Connect, log in, cd into remote_dir (mkdir -p, appending made dirs to `created`).
    Yields (put(local, name, progress_cb(bytes_done)), remove(name))."""
    host, port = u["host"], int(u["port"])
    d = "/" + "/".join(p for p in u["remote_dir"].split("/") if p)
    created = [] if created is None else created
    if u["protocol"] == Protocol.SFTP:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            no_creds = not u["password"] and not u["private_key_path"]
            ssh.connect(host, port, username=u["username"] or None, password=u["password"] or None,
                        key_filename=u["private_key_path"] or None, timeout=15, banner_timeout=15,
                        auth_timeout=15, allow_agent=no_creds, look_for_keys=no_creds)
            sftp = ssh.open_sftp()
            sftp.get_channel().settimeout(60)
            path = "/" if d.startswith("/") else ""
            for part in [p for p in d.split("/") if p]:
                path = posixpath.join(path, part)
                try:
                    sftp.stat(path)
                except OSError:
                    sftp.mkdir(path)
                    created.append(path)
            sftp.chdir(d)
            yield (staged(lambda local, name, cb: sftp.put(local, name, callback=lambda done, _t: cb(done)),
                          sftp.posix_rename, sftp.remove), sftp.remove)
        finally:
            ssh.close()
    elif u["protocol"] == Protocol.SMB:
        cache = {}
        kw = {"port": port, "connection_cache": cache}
        user = f"{u['domain']}\\{u['username']}" if u.get("domain") else (u["username"] or None)

        def unc(p):  # p: absolute posix path inside the share
            return "\\\\" + host + "\\" + u["share"] + p.replace("/", "\\")
        try:
            smbclient.register_session(host, username=user, password=u["password"] or None,
                                       connection_timeout=15, **kw)
            path = ""
            for part in [p for p in d.split("/") if p]:
                path += "/" + part
                try:
                    smbclient.stat(unc(path), **kw)
                except OSError:
                    smbclient.mkdir(unc(path), **kw)
                    created.append(path)

            def send(local, name, cb):
                done = 0
                with open(local, "rb") as src, smbclient.open_file(unc(posixpath.join(d, name)), mode="wb", **kw) as f:
                    while chunk := src.read(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        cb(done)

            def rm(name):
                smbclient.remove(unc(posixpath.join(d, name)), **kw)
            # replace (not rename): overwrites an existing name instead of failing, like posix_rename
            yield staged(send, lambda a, b: smbclient.replace(unc(posixpath.join(d, a)), unc(posixpath.join(d, b)), **kw),
                         rm), rm
        finally:
            smbclient.reset_connection_cache(connection_cache=cache)
    else:
        ftp = ftplib.FTP_TLS() if u["protocol"] == Protocol.FTPS else ftplib.FTP()
        try:
            ftp.connect(host, port, timeout=15)
            ftp.login(u["username"] or "anonymous", u["password"] or "")
            if u["protocol"] == Protocol.FTPS:
                ftp.prot_p()
            ftp.cwd("/")
            path = ""
            for part in [p for p in d.split("/") if p]:
                path += "/" + part
                try:
                    ftp.cwd(part)
                except ftplib.error_perm:
                    ftp.mkd(part)
                    created.append(path)
                    ftp.cwd(part)

            def put(local, name, cb):
                done = [0]

                def chunk(b):
                    done[0] += len(b)
                    cb(done[0])
                with open(local, "rb") as f:
                    ftp.storbinary("STOR " + name, f, callback=chunk)
            yield staged(put, ftp.rename, ftp.delete), ftp.delete
        finally:
            try:
                ftp.quit()
            except Exception:
                ftp.close()
