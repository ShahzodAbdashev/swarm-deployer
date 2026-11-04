"""Mock self-hosted GitLab for the sdtest lab (TESTENV.md §8.3). Stdlib only, plus the `git` binary.
  python3 gitlab_mock.py <L> <port>      (binds 127.0.0.1; started by up.sh, pid in $L/gitlab.pid)
OAuth2 authorize/token with PKCE S256 + refresh rotation, a slice of /api/v4 (user, projects, branches, raw files,
project + group CI/CD variables), git smart HTTP via `git http-backend` with basic auth oauth2:<token>, and /_mock/*
test controls. OAuth tokens live in memory (a restart invalidates them); PATs are static."""
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

L, PORT = sys.argv[1], int(sys.argv[2])
USERS = {1: ("sdtest-dev", "SDTest Dev"), 2: ("sdtest-viewer", "SDTest Viewer")}
PATS = {"glpat-sdtest-dev-0001": (1, {"api", "read_repository"}), "glpat-sdtest-viewer-0002": (2, {"read_api"})}
CLIENT_ID, CLIENT_SECRET, APP_SCOPES = "sdtest-oauth-client", "sdtest-oauth-secret", {"api"}
REDIRECT_RE = re.compile(r"^http://127\.0\.0\.1:\d+/api/auth/gitlab/callback$")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
S = {"ttl": 7200, "codes": {}, "access": {}, "refresh": {}, "log": []}
LOCK = threading.Lock()


def labenv():
    try:
        return {k: v.strip().strip("'") for k, _, v in (l.partition("=") for l in open(os.path.join(L, "lab.env"))) if v}
    except OSError:
        return {}


def var(key, value, masked=False, hidden=False, vtype="env_var", scope="*"):
    return {"key": key, "value": None if hidden else value, "variable_type": vtype, "protected": False,
            "masked": masked or hidden, "hidden": hidden, "raw": False, "environment_scope": scope}


def data():
    """Built per request from lab.env + the SSH key, so it is always current (no state file)."""
    e = labenv()
    try:
        key = open(os.path.join(L, "keys", "sdtest_ed25519")).read()
    except OSError:
        key = ""
    groups = {
        10: {"id": 10, "full_path": "sdtest", "parent_id": None, "vars": [
            var("BASE_MONGO_HOST", "mongo.sdtest.local"), var("BASE_MONGO_PASSWORD", "sdtest-mongo-secret-42", masked=True),
            var("WEB3_GREETING", "hello from root group"), var("BASE_DEVELOPMENT_HOST", "127.0.0.1"),
            var("BASE_DEVELOPMENT_HOST_USER", "deploy"), var("BASE_DEVELOPMENT_SSH_PRIVATE_KEY", key, vtype="file"),
            var("ZIP_PASSWORD", "never-readable", hidden=True)]},
        11: {"id": 11, "full_path": "sdtest/apps", "parent_id": 10, "vars": [
            var("WEB3_GREETING", "hello from subgroup"), var("CI_REGISTRY", "127.0.0.1:5050")]},
    }
    web3 = [var("WEB3_SERVICE_PORT", "8084"), var("WEB3_GREETING", "hello from project var"),
            var("WEB3_GREETING", "prod greeting", scope="production"),
            var("CI_REGISTRY_USER", e.get("REG_USER", "sdtest-reg")),
            var("CI_REGISTRY_PASSWORD", e.get("REG_PASS", "sdtest-reg-pass"), masked=True),
            var("CI_REGISTRY_IMAGE", "127.0.0.1:5050/sdtest/web3"), var("SERVICE_NAME", "sdtest_web3"),
            var("HEALTHCHECK_URL", "http://127.0.0.1:8084/health"), var("SD_PACKAGE", "sdtest-web3"),
            var("SD_TARGET_ID", "lab")]
    projects = {}
    for pid, path, gid, vs in ((101, "sdtest/mock-web1", 10, []), (102, "sdtest/mock-web2", 10, []),
                               (103, "sdtest/apps/mock-web3", 11, web3)):
        name = path.rsplit("/", 1)[1]
        projects[pid] = {"id": pid, "name": name, "path": name, "path_with_namespace": path,
                         "http_url_to_repo": f"http://gitlab.sdtest.invalid/{path}.git", "default_branch": "main",
                         "visibility": "private",
                         "namespace": {"id": gid, "kind": "group", "full_path": groups[gid]["full_path"]},
                         "container_registry_image_prefix": f"127.0.0.1:5050/{path}",
                         "_repo": os.path.join(L, "repos", name), "_vars": vs}
    return groups, projects


def pub(p):
    return {k: v for k, v in p.items() if not k.startswith("_")}


def find(items, ref, key):
    return next((x for x in items.values() if str(x["id"]) == ref or x[key] == ref), None)


def issue(uid, scope):
    a, r = "gloat-" + secrets.token_hex(20), "glort-" + secrets.token_hex(20)
    S["access"][a] = {"uid": uid, "scopes": set(scope.split()), "exp": time.time() + S["ttl"], "refresh": r}
    S["refresh"][r] = {"uid": uid, "scope": scope, "access": a}
    return {"access_token": a, "token_type": "Bearer", "expires_in": S["ttl"], "refresh_token": r, "scope": scope,
            "created_at": int(time.time())}


def token_info(tok):
    """(uid, scopes) for a PAT or a live OAuth access token, else None."""
    if tok in PATS:
        return PATS[tok]
    with LOCK:
        a = S["access"].get(tok)
    return (a["uid"], a["scopes"]) if a and a["exp"] > time.time() else None


class H(BaseHTTPRequestHandler):
    server_version = "gitlab-mock/1"

    def log_message(self, fmt, *a):  # stderr -> $L/gitlab.log; the path only (no query), never headers
        sys.stderr.write("%s %s %s\n" % (self.command, urlsplit(self.path).path, a[1] if len(a) > 1 else ""))

    def send(self, code, body=b"", ctype="application/json", headers=()):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode() if ctype == "application/json" else str(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, url):
        self.send(302, b"", "text/plain", [("Location", url)])

    def body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                n = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if n == 0:
                    self.rfile.readline()
                    return out
                out += self.rfile.read(n)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def note(self, grant=None, uid=None):
        if not self.path.startswith("/_mock/log"):
            with LOCK:
                S["log"].append({"t": round(time.time(), 3), "method": self.command, "path": urlsplit(self.path).path,
                                 "grant_type": grant, "user": USERS[uid][0] if uid else None})

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def route(self):
        u = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        parts = [unquote(p) for p in u.path.split("/")][1:]
        try:
            if m := re.match(r"^/(.+?)\.git/(info/refs|git-upload-pack|git-receive-pack|HEAD)$", u.path):
                return self.git(unquote(m.group(1)), m.group(2), u.query)
            if u.path == "/oauth/authorize" and self.command == "GET":
                return self.authorize(q)
            if u.path == "/oauth/token" and self.command == "POST":
                return self.token()
            if parts[:1] == ["avatar"]:
                self.note()
                return self.send(200, PNG, "image/png")
            if parts[:1] == ["_mock"]:
                return self.mock(parts[1] if len(parts) > 1 else "")
            if parts[:2] == ["api", "v4"]:
                return self.api(parts[2:], q)
            self.note()
            self.send(404, {"message": "404 Not Found"})
        except BrokenPipeError:
            pass

    # ---------------------------------------------------------------- OAuth
    def authorize(self, q):
        self.note()
        ru = q.get("redirect_uri", "")
        if q.get("client_id") != CLIENT_ID or not REDIRECT_RE.match(ru):
            return self.send(400, "invalid client_id or redirect_uri", "text/plain")
        back = lambda **kw: self.redirect(ru + "?" + urlencode({**kw, "state": q.get("state", "")}))  # noqa: E731
        if q.get("response_type") != "code" or not q.get("code_challenge") or q.get("code_challenge_method") != "S256":
            return back(error="invalid_request")
        scope = q.get("scope") or "api"
        if set(scope.split()) - APP_SCOPES:
            return back(error="invalid_scope")
        code = secrets.token_hex(16)
        with LOCK:
            S["codes"][code] = {"challenge": q["code_challenge"], "redirect_uri": ru, "scope": scope, "uid": 1}
        back(code=code)

    def token(self):
        f = {k: v[0] for k, v in parse_qs(self.body().decode()).items()}
        if (a := self.headers.get("Authorization", "")).startswith("Basic "):  # client creds via basic auth
            cid, _, csec = base64.b64decode(a[6:]).decode().partition(":")
            f.setdefault("client_id", unquote(cid))
            f.setdefault("client_secret", unquote(csec))
        g = f.get("grant_type")
        bad = lambda: self.send(400, {"error": "invalid_grant"})  # noqa: E731
        if f.get("client_id") != CLIENT_ID or (f.get("client_secret") or CLIENT_SECRET) != CLIENT_SECRET:
            self.note(g)
            return bad()
        with LOCK:
            if g == "authorization_code":
                c = S["codes"].pop(f.get("code", ""), None)  # single use
                ver = f.get("code_verifier", "").encode()
                chal = base64.urlsafe_b64encode(hashlib.sha256(ver).digest()).rstrip(b"=").decode()
                if not c or c["redirect_uri"] != f.get("redirect_uri") or not ver or chal != c["challenge"]:
                    out = None
                else:
                    out = issue(c["uid"], c["scope"])
                uid = c and c["uid"]
            elif g == "refresh_token":
                r = S["refresh"].pop(f.get("refresh_token", ""), None)
                if r:
                    S["access"].pop(r["access"], None)
                    out, uid = issue(r["uid"], r["scope"]), r["uid"]
                else:
                    out, uid = None, None
            else:
                out, uid = None, None
        self.note(g, uid if out else None)
        return self.send(200, out) if out else bad()

    # ---------------------------------------------------------------- test controls
    def mock(self, what):
        if what == "log" and self.command == "GET":
            with LOCK:
                return self.send(200, list(S["log"]))
        if self.command != "POST":
            return self.send(405, {"message": "405 Method Not Allowed"})
        raw = self.body()
        with LOCK:
            if what == "ttl":
                S["ttl"] = int(json.loads(raw or b"{}").get("seconds", 7200))
            elif what == "revoke":
                S["access"].clear()
                S["refresh"].clear()
            elif what == "reset":
                S["ttl"] = 7200
                S["log"].clear()
            else:
                return self.send(404, {"message": "404 Not Found"})
            return self.send(200, {"ok": True, "ttl": S["ttl"]})

    # ---------------------------------------------------------------- REST API
    def api(self, p, q):
        a = self.headers.get("Authorization", "")
        tok = a[7:].strip() if a.startswith("Bearer ") else self.headers.get("PRIVATE-TOKEN", "")
        ti = token_info(tok) if tok else None
        self.note(uid=ti and ti[0])
        if not ti:
            return self.send(401, {"message": "401 Unauthorized"})
        uid, scopes = ti
        groups, projects = data()
        if p == ["user"]:
            name, full = USERS[uid]
            return self.send(200, {"id": uid, "username": name, "name": full,
                                   "avatar_url": f"http://127.0.0.1:{PORT}/avatar/{name}.png",
                                   "web_url": f"http://127.0.0.1:{PORT}/{name}"})
        if p == ["projects"]:
            return self.send(200, [pub(x) for x in projects.values()])
        if len(p) >= 2 and p[0] == "projects":
            pr = find(projects, p[1], "path_with_namespace")
            if not pr:
                return self.send(404, {"message": "404 Project Not Found"})
            rest = p[2:]
            if rest == []:
                return self.send(200, pub(pr))
            if rest == ["variables"]:
                return self.vars(scopes, pr["_vars"])
            if rest == ["repository", "branches"]:
                r = subprocess.run(["git", "-C", pr["_repo"], "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                                   capture_output=True, text=True)
                return self.send(200, [{"name": b, "default": b == "main"} for b in r.stdout.split()])
            if len(rest) == 4 and rest[:2] == ["repository", "files"] and rest[3] == "raw":
                ref = q.get("ref", "main")
                if ref.startswith("-") or ".." in rest[2]:
                    return self.send(400, {"message": "400 Bad Request"})
                r = subprocess.run(["git", "-C", pr["_repo"], "show", f"{ref}:{rest[2]}"], capture_output=True)
                if r.returncode:
                    return self.send(404, {"message": "404 File Not Found"})
                return self.send(200, r.stdout, "text/plain; charset=utf-8")
        if len(p) == 3 and p[0] == "groups" and p[2] == "variables":
            g = find(groups, p[1], "full_path")
            return self.vars(scopes, g["vars"]) if g else self.send(404, {"message": "404 Group Not Found"})
        self.send(404, {"message": "404 Not Found"})

    def vars(self, scopes, vs):
        if "api" not in scopes:
            return self.send(403, {"message": "403 Forbidden"})
        self.send(200, vs)

    # ---------------------------------------------------------------- git smart HTTP
    def git(self, path, rest, query):
        a = self.headers.get("Authorization", "")
        ti = None
        if a.startswith("Basic "):
            try:
                ti = token_info(base64.b64decode(a[6:]).decode().partition(":")[2])
            except ValueError:
                ti = None
        self.note(uid=ti and ti[0])
        if not ti:
            return self.send(401, "HTTP Basic: Access denied", "text/plain", [("WWW-Authenticate", 'Basic realm="GitLab"')])
        if not ti[1] & {"api", "read_repository"}:
            return self.send(403, "You are not allowed to download code from this project.", "text/plain")
        if rest == "git-receive-pack" or "git-receive-pack" in query:
            return self.send(403, "You are not allowed to push code to this project.", "text/plain")
        pr = find(data()[1], path, "path_with_namespace")
        if not pr:
            return self.send(404, "The project you were looking for could not be found.", "text/plain")
        body = self.body() if self.command == "POST" else b""
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GIT_PROJECT_ROOT": os.path.join(L, "repos"),
               "GIT_HTTP_EXPORT_ALL": "1", "PATH_INFO": f"/{pr['name']}/.git/{rest}", "QUERY_STRING": query,
               "REQUEST_METHOD": self.command, "CONTENT_TYPE": self.headers.get("Content-Type", ""),
               "CONTENT_LENGTH": str(len(body)), "REMOTE_USER": USERS[ti[0]][0], "REMOTE_ADDR": "127.0.0.1"}
        for h, k in (("Git-Protocol", "HTTP_GIT_PROTOCOL"), ("Content-Encoding", "HTTP_CONTENT_ENCODING")):
            if self.headers.get(h):
                env[k] = self.headers[h]
        r = subprocess.run(["git", "http-backend"], input=body, capture_output=True, env=env)
        head, sep, out = r.stdout.partition(b"\r\n\r\n")
        if not sep:
            head, sep, out = r.stdout.partition(b"\n\n")
        code, ctype, hdrs = 200, "application/octet-stream", []
        for line in head.decode("latin-1").splitlines():
            k, _, v = line.partition(":")
            k, v = k.strip(), v.strip()
            if k.lower() == "status":
                code = int(v.split()[0])
            elif k.lower() == "content-type":
                ctype = v
            elif k and k.lower() != "content-length":
                hdrs.append((k, v))
        if r.returncode and not sep:
            return self.send(500, r.stderr[-500:], "text/plain")
        self.send(code, out, ctype, hdrs)


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
