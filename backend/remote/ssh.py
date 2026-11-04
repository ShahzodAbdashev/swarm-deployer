"""SSH to targets (paramiko): host key policy, Shell, connection test."""
import base64
import hashlib
import json
import shlex
import threading

import paramiko

from backend.core.enums import KeyPolicy
from backend.core.errors import Fail
from backend.core.paths import KNOWN_HOSTS
from backend.utils.text import jparse, last_line


kh_lock = threading.Lock()


def fingerprint(key):
    return "SHA256:" + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")


def shell_cmd(argv, redirect=None):
    """The single quoting helper: every remote command string is built here (SPEC §0.2)."""
    s = " ".join(shlex.quote(a) for a in argv)
    if redirect:  # stdout only into the file; stderr still reaches the log via set_combine_stderr in run()
        return s + " > " + shlex.quote(redirect)
    return s + " 2>&1"


class HostKeyPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, log, save, where):
        self.log, self.save, self.where = log, save, where

    def missing_host_key(self, client, hostname, key):
        fp = f"{key.get_name()} {fingerprint(key)}"
        client.get_host_keys().add(hostname, key.get_name(), key)
        if self.save:
            with kh_lock:  # reload + add + save so parallel sessions don't drop each other's keys
                hk = paramiko.HostKeys()
                try:
                    hk.load(KNOWN_HOSTS)
                except OSError:
                    pass
                hk.add(hostname, key.get_name(), key)
                hk.save(KNOWN_HOSTS)
            self.log(f"WARNING: host key for {self.where} auto-accepted ({fp})")
        else:
            self.log(f"WARNING: unknown host key for {self.where} accepted for this session only ({fp})")


class Shell:
    """One SSH session to a target or extra node."""

    def __init__(self, spec, policy=KeyPolicy.AUTO_ADD, docker_cmd="docker", log=None):
        self.host, self.port = spec["host"], int(spec["port"])
        self.label = f"{spec['username']}@{self.host}:{self.port}"
        self.D = shlex.split(docker_cmd)
        self.log = log or (lambda s: None)
        self._sftp = None
        c = paramiko.SSHClient()
        if policy == KeyPolicy.REJECT:
            c.load_system_host_keys()
            c.set_missing_host_key_policy(paramiko.RejectPolicy())
        else:
            c.set_missing_host_key_policy(HostKeyPolicy(self.log, policy == KeyPolicy.AUTO_ADD, f"{self.host}:{self.port}"))
        try:
            c.load_host_keys(KNOWN_HOSTS)
        except OSError:
            pass
        no_creds = not spec.get("password") and not spec.get("private_key_path")
        try:
            c.connect(self.host, self.port, username=spec["username"], password=spec.get("password") or None,
                      key_filename=spec.get("private_key_path") or None, timeout=15, banner_timeout=15,
                      auth_timeout=15, allow_agent=no_creds, look_for_keys=no_creds)
        except Exception:
            c.close()
            raise
        self.c = c
        key = c.get_transport().get_remote_server_key()
        self.host_key = f"{key.get_name()} {fingerprint(key)}"

    def run(self, argv, timeout=60, redirect=None, quiet=False, stdin=None):
        """Run argv remotely (quoted), stream merged output to the log. Returns (exit_code, output)."""
        if not quiet:
            self.log(f"$ [{self.host}] {shell_cmd(argv, redirect)}")
        chan = self.c.get_transport().open_session(timeout=15)
        chan.settimeout(timeout)
        lines, buf = [], b""

        def emit(raw):
            for ln in raw.decode("utf-8", "replace").replace("\r", "\n").split("\n"):
                if ln.strip():
                    lines.append(ln)
                    if not quiet:
                        self.log(ln)
        try:
            chan.set_combine_stderr(True)
            chan.exec_command(shell_cmd(argv, redirect))
            if stdin is not None:  # secrets (docker login) go on stdin, never argv or the log
                chan.sendall(stdin.encode())
                chan.shutdown_write()
            while True:
                try:
                    data = chan.recv(65536)
                except TimeoutError:
                    raise Fail(f"command timed out after {timeout}s: {argv[0]} {' '.join(argv[1:3])}")
                if not data:
                    break
                buf += data
                if b"\n" in buf or b"\r" in buf:
                    cut = max(buf.rfind(b"\n"), buf.rfind(b"\r")) + 1
                    emit(buf[:cut])
                    buf = buf[cut:]
            if buf:
                emit(buf)
            code = chan.recv_exit_status()
        finally:
            chan.close()
        return code, "\n".join(lines)

    def check(self, argv, timeout=60, redirect=None, what=None, stdin=None):
        code, out = self.run(argv, timeout, redirect, stdin=stdin)
        if code != 0:
            tail = last_line(out)
            raise Fail(f"{what or argv[0]} failed: {tail} (exit {code})" if tail else
                       f"{what or argv[0]} exited with code {code}")
        return out

    def sftp(self):
        if self._sftp is None:
            self._sftp = self.c.open_sftp()
            self._sftp.get_channel().settimeout(60)
        return self._sftp

    def read_json(self, path):
        with self.sftp().open(path, "r") as f:
            return json.loads(f.read().decode("utf-8", "replace"))

    def close(self):
        try:
            if self._sftp:
                self._sftp.close()
        finally:
            self.c.close()


def connect_target(t, log=None):
    return Shell(t, t["host_key_policy"], t["docker_cmd"], log)


def probe_target(t):
    try:
        sh = connect_target(t)
    except Exception as e:
        return {"ok": False, "message": f"{t['username']}@{t['host']}:{t['port']}: {type(e).__name__}: {e}",
                "swarm_manager": False, "docker_version": None, "host_key": None}
    try:
        code, out = sh.run(sh.D + ["info", "--format", "{{json .Swarm}}"], quiet=True)
        if code:
            return {"ok": False, "message": f"{sh.label} · docker failed: {last_line(out)}", "swarm_manager": False,
                    "docker_version": None, "host_key": sh.host_key}
        sw = jparse(out) or {}
        code, ver = sh.run(sh.D + ["version", "--format", "{{.Server.Version}}"], quiet=True)
        ver = last_line(ver) if code == 0 else None
        mgr = sw.get("LocalNodeState") == "active" and sw.get("ControlAvailable") is True
        res = {"ok": mgr, "message": f"{sh.label} · Docker {ver} · {'swarm manager' if mgr else 'not a swarm manager'}",
               "swarm_manager": mgr, "docker_version": ver, "host_key": sh.host_key}
    finally:
        sh.close()
    for n in t["extra_nodes"]:
        try:
            nsh = Shell(n, t["host_key_policy"], t["docker_cmd"])
            try:
                code, out = nsh.run(nsh.D + ["version", "--format", "{{.Server.Version}}"], quiet=True)
            finally:
                nsh.close()
            if code:
                raise Fail(f"docker failed: {last_line(out)}")
        except Exception as e:
            res["ok"] = False
            res["message"] += f" · node {n['host']}:{n['port']}: {e}"
    return res
