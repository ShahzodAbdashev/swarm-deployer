"""GitLab chain test (TESTENV.md §10): mock GitLab sign-in (PAT + OAuth/PKCE, refresh, rejected refresh) in BOTH apps ->
.env import -> Build Packager builds a GitLab project with a generated .env -> SMB upload -> Swarm Deployer watches the
share -> deploy with password -> job + backup folders, load, @current tag, registry push by digest, service update,
health script, .env visible in the running app -> unhealthy build rolls back -> build_tar.sh-style ZipCrypto flat zip
-> manual rollback -> restart recovery in registry mode -> prune_after -> auto-deploy over SMB -> secret scans.
Run: /home/shahzod/mywork/swarm-deployer/.venv/bin/python tests/gitlab_chain_test.py
Needs the lab up and fully seeded (flock -o $L/lab.lock testenv/up.sh --node2; testenv/seed.sh).
Swarm commands only inside sdtest-* containers (tdocker / docker exec sdtest-target)."""
import http.client
import io
import json
import os
import re
import shutil
import signal
import sys
import tarfile
import tempfile
import time
import zipfile
from urllib.parse import parse_qs, quote, urlsplit

import pyzipper

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from full_chain_test import (App, BP_PY, BP_ROOT, ENV, L, RESULTS, ROOT, ZIP_PW, check, clean_env,  # noqa: E402
                             http_get, lab_lock, run, tdocker, wait_done)

GL, REG, FSV = ENV["gitlab"], ENV["registry"], ENV["file_server"]
SMB = FSV["smb"]
GITLAB_PAT, GITLAB_VIEWER_PAT, GL_URL = GL["pat"], GL["viewer_pat"], GL["url"]
FILES_PASS = SMB["password"]
SD_PY = os.path.join(ROOT, ".venv/bin/python")
WEB3 = "127.0.0.1:5050/sdtest/web3"
PROJECT = "sdtest/apps/mock-web3"
CLONE_URL = f"{GL_URL}/{PROJECT}.git"
GL_DIR = os.path.join(FSV["local_root"], "gl")
PRELOAD = os.path.join(L, "gl-preload.tar")
SECRETS = [GITLAB_PAT, GITLAB_VIEWER_PAT, GL["client_secret"], REG["password"], "sdtest-mongo-secret-42", ZIP_PW,
           FILES_PASS]
TOKEN_PREFIXES = ("gloat-", "glort-", "glpat-")
EXPECTED_ENV = ("SVC_PORT=8084\nGREETING=hello from project var\nMONGO_HOST=mongo.sdtest.local\n"
                "MONGO_PASSWORD=sdtest-mongo-secret-42\nAPP_ENV=development\n")
ENV_KEYS = ["SVC_PORT", "GREETING", "MONGO_HOST", "MONGO_PASSWORD", "APP_ENV"]
ACCEPT = ("application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, "
          "application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json")
RESP = []         # every API response body of both apps except /api/gitlab/env-preview (leak scan, D22)
HOST_IMAGES = set()


# ---------------------------------------------------------------- helpers

def texec(*a):
    return run("docker", "exec", "sdtest-target", *a)


def web3(path):
    return texec("wget", "-qO-", f"http://127.0.0.1:8084{path}").stdout


def reg_digest(tag):
    r = texec("curl", "-sI", "-u", f"{REG['user']}:{REG['password']}", "-H", f"Accept: {ACCEPT}",
              f"http://127.0.0.1:5050/v2/sdtest/web3/manifests/{tag}")
    m = re.search(r"(?im)^docker-content-digest:\s*(sha256:[0-9a-f]{64})", r.stdout)
    return m.group(1) if m else None


def spec_image():
    return tdocker("service", "inspect", "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}", "sdtest_web3")[1]


def tiid(ref):
    r = texec("docker", "image", "inspect", "--format", "{{.Id}}", ref)
    return r.stdout.strip() if r.returncode == 0 else None


def J(app, method, path, body=None, timeout=120):
    st, r = app.j(method, path, body, timeout)
    if not path.startswith("/api/gitlab/env-preview"):
        RESP.append(r if isinstance(r, str) else json.dumps(r))
    return st, r


def hop(url, host_port=None):
    """One GET without following redirects. Returns (status, Location)."""
    u = urlsplit(url)
    c = http.client.HTTPConnection(u.hostname or "127.0.0.1", u.port or host_port, timeout=30)
    c.request("GET", u.path + ("?" + u.query if u.query else ""))
    r = c.getresponse()
    r.read()
    c.close()
    return r.status, r.getheader("Location") or ""


def oauth(app):
    """start (app, 302) -> authorize (mock, 302) -> callback (app, 302). Returns (final Location, [locations])."""
    st1, loc1 = hop(f"http://127.0.0.1:{app.port}/api/auth/gitlab/start")
    if st1 != 302 or "/oauth/authorize" not in loc1:
        return loc1, [(st1, loc1)]
    st2, loc2 = hop(loc1)
    if st2 != 302:
        return loc2, [(st1, loc1), (st2, loc2)]
    st3, loc3 = hop(loc2, app.port)
    return loc3, [(st1, loc1), (st2, loc2), (st3, loc3)]


def qs_of(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def mock(method, path, body=None):
    c = http.client.HTTPConnection("127.0.0.1", GL["port"], timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    c.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
    r = c.getresponse()
    raw = r.read()
    c.close()
    try:
        return r.status, json.loads(raw)
    except ValueError:
        return r.status, raw.decode("utf-8", "replace")


def grants(kind):
    return [e for e in mock("GET", "/_mock/log")[1] if e.get("grant_type") == kind]


def leaks(text):
    return [s for s in SECRETS + list(TOKEN_PREFIXES) if s in text]


def phases(job):
    return {p["name"]: p["status"] for p in job.get("phases", [])}


def safety_grep():
    bad = [m.group(0) for m in re.finditer(r"(?<!exec sdtest-target )docker (service|swarm|stack)\b", open(__file__).read())]
    check("S safety: no host-daemon swarm commands in this file", not bad, bad)


def redirect_probe():
    """A 'GitLab' that 302s every request to a second server; returns (url, hits seen by the second server)."""
    import http.server
    import threading
    hits = []

    class Sink(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.headers.get("Authorization"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass
    sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)

    class Hop(Sink):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{sink.server_port}{self.path}")
            self.end_headers()
    hop_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hop)
    for srv in (sink, hop_srv):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{hop_srv.server_port}", hits, (sink, hop_srv)


def write_env(path, text):
    with open(path, "w") as f:
        f.write(text)


# ---------------------------------------------------------------- Build Packager (B)

def bp_build(bp, branch, env_content):
    for _ in range(5):  # Build Packager refuses a 2nd build of a service in the same second
        st, job = J(bp, "POST", "/api/jobs", {
            "service": "sdtest-web3", "repo_url": CLONE_URL, "branch": branch,
            "env": {"content": env_content, "path": ".env", "source": "gitlab"}, "preload_tars": [PRELOAD],
            "password": ZIP_PW, "password_confirm": ZIP_PW, "upload": True})
        if st != 409:
            break
        time.sleep(1.1)
    if st != 201:
        return st, job
    HOST_IMAGES.add(job["image_tag"])
    return st, wait_done(bp, f"/api/jobs/{job['id']}", 600)


def phase_bp(bp, bp_dir):
    # B1 startup .env import
    st, up = J(bp, "GET", "/api/config/upload")
    check("B1 .env import: upload config smb/host/port/share/remote_dir/enabled, has_password, no password",
          st == 200 and up.get("protocol") == "smb" and up.get("host") == "127.0.0.1" and up.get("port") == SMB["port"]
          and up.get("share") == "releases" and up.get("remote_dir") == "/gl" and up.get("enabled") is True
          and up.get("has_password") is True and "password" not in up, up)
    st, g = J(bp, "GET", "/api/config/gitlab")
    check("B1 .env import: gitlab client id + secret, oauth_available",
          st == 200 and g.get("client_id") == GL["client_id"] and g.get("has_client_secret") is True
          and g.get("oauth_available") is True and g.get("url") == GL_URL, g)
    cj = os.path.join(bp_dir, "data", "config.json")
    cfg_txt = open(cj).read() if os.path.exists(cj) else ""
    check("B1 config.json has env_import_sha, mode 600", '"env_import_sha"' in cfg_txt
          and json.loads(cfg_txt).get("env_import_sha") and oct(os.stat(cj).st_mode & 0o777) == "0o600", cj)
    check("B15 startup import ignored SD_TARGET_PORT (deployer key)", "SD_TARGET" not in cfg_txt)

    # B2
    st, s = J(bp, "GET", "/api/auth/status")
    check("B2 before sign-in: gitlab.logged_in false, logged_in false, provider null",
          st == 200 and s["gitlab"]["logged_in"] is False and s["logged_in"] is False and s["provider"] is None, s)

    # B3 PAT
    st, r = J(bp, "POST", "/api/auth/gitlab/token", {"token": "glpat-not-a-real-token", "url": GL_URL})
    check("B3 bad PAT -> 401", st == 401, (st, r))
    st, r = J(bp, "POST", "/api/auth/gitlab/token", {"token": GITLAB_VIEWER_PAT, "url": GL_URL})
    check("B3 viewer PAT -> 200 sdtest-viewer", st == 200 and r.get("login") == "sdtest-viewer", (st, r))
    st, pv = J(bp, "POST", "/api/gitlab/env-preview", {"repo_url": CLONE_URL, "branch": "v2"})
    check("B3 env-preview as viewer degrades: 200, variables warning, missing vars",
          st == 200 and any("403" in w or "variables" in w for w in pv.get("warnings", []))
          and {"WEB3_SERVICE_PORT", "BASE_MONGO_HOST"} <= set(pv.get("missing", [])), (st, pv))
    st, r = J(bp, "POST", "/api/auth/logout", {})
    check("B3 logout -> exactly {logged_in: false}", st == 200 and r == {"logged_in": False}, r)

    # B4 OAuth + PKCE
    mock("POST", "/_mock/reset", {})
    final, hops = oauth(bp)
    a = qs_of(hops[0][1])
    check("B4 start -> 302 to /oauth/authorize, S256, state, redirect_uri on 127.0.0.1:<bp port>",
          hops[0][0] == 302 and "/oauth/authorize" in hops[0][1] and a.get("code_challenge_method") == "S256"
          and a.get("state") and a.get("redirect_uri") == f"http://127.0.0.1:{bp.port}/api/auth/gitlab/callback"
          and a.get("scope") == "api", hops)
    cb = qs_of(hops[1][1]) if len(hops) > 1 else {}
    check("B4 mock -> 302 to the callback with code and the same state",
          len(hops) > 1 and hops[1][0] == 302 and cb.get("code") and cb.get("state") == a.get("state"), hops)
    check("B4 callback -> 302 /#/dashboard", len(hops) == 3 and hops[2][0] == 302 and final.endswith("/#/dashboard"), hops)
    st, s = J(bp, "GET", "/api/auth/status")
    check("B4 status: provider gitlab, method oauth, login sdtest-dev",
          s.get("provider") == "gitlab" and s["gitlab"].get("method") == "oauth" and s["gitlab"].get("login") == "sdtest-dev"
          and s.get("login") == "sdtest-dev", s)
    check("B4 mock saw exactly one authorization_code grant", len(grants("authorization_code")) == 1,
          mock("GET", "/_mock/log")[1])

    # B5 bad state
    st, loc = hop(f"http://127.0.0.1:{bp.port}/api/auth/gitlab/callback?code=x&state=bogus")
    check("B5 bad state -> 302 /#/login", st == 302 and loc.endswith("/#/login"), (st, loc))
    s1, s2 = J(bp, "GET", "/api/auth/status")[1], J(bp, "GET", "/api/auth/status")[1]
    check("B5 oauth_error mentions state, one-shot", "state" in str(s1.get("oauth_error")) and s2.get("oauth_error") is None,
          (s1.get("oauth_error"), s2.get("oauth_error")))

    # B6 refresh, then rejected refresh
    mock("POST", "/_mock/ttl", {"seconds": 2})
    oauth(bp)
    time.sleep(3)
    st, r = J(bp, "GET", "/api/gitlab/projects")
    check("B6 expired access token is refreshed: projects 200, mock saw a refresh_token grant",
          st == 200 and grants("refresh_token"), (st, r))
    mock("POST", "/_mock/revoke", {})
    time.sleep(3)
    st, r = J(bp, "GET", "/api/gitlab/projects")
    st2, s = J(bp, "GET", "/api/auth/status")
    check("B6 rejected refresh -> 401 and signed out", st == 401 and s["gitlab"]["logged_in"] is False, (st, r, s))
    mock("POST", "/_mock/ttl", {"seconds": 7200})
    final, hops = oauth(bp)
    check("B6 OAuth sign-in again", final.endswith("/#/dashboard"), hops)

    # B7 data
    st, ps = J(bp, "GET", "/api/gitlab/projects")
    p3 = next((p for p in ps if p.get("full_name") == PROJECT), None) if st == 200 else None
    check("B7 projects: mock-web3 clone_url from the configured URL, private",
          p3 and p3["clone_url"] == CLONE_URL and p3["private"] is True, ps)
    st, bs = J(bp, "GET", f"/api/gitlab/branches?project={quote(PROJECT, safe='')}")
    check("B7 branches main v2 unhealthy broken", st == 200 and {"main", "v2", "unhealthy", "broken"} <= {b["name"] for b in bs},
          (st, bs))

    # B8 / B9 preview
    st, pv = J(bp, "POST", "/api/gitlab/env-preview", {"repo_url": CLONE_URL, "branch": "v2"})
    check("B8 preview v2: job export_env, 5 keys in order, nothing missing, expected content",
          st == 200 and pv.get("job") == "export_env" and pv.get("keys") == ENV_KEYS and pv.get("missing") == []
          and pv.get("content") == EXPECTED_ENV, (st, {k: v for k, v in (pv or {}).items() if k != "content"}))
    src = pv.get("sources", {}) if st == 200 else {}
    check("B8 sources: group sdtest / project / variables",
          src.get("BASE_MONGO_HOST") == "group sdtest" and src.get("WEB3_GREETING") == "project"
          and src.get("APP_ENV_NAME") == "variables", src)
    env_v2 = pv.get("content", EXPECTED_ENV) if st == 200 else EXPECTED_ENV
    st, pu = J(bp, "POST", "/api/gitlab/env-preview", {"repo_url": CLONE_URL, "branch": "unhealthy"})
    mh = [ln for ln in pu.get("lines", []) if ln.get("key") == "MONGO_HOST"] if st == 200 else []
    check("B9 preview unhealthy: missing WEB3_MONGO_HOST_TYPO, MONGO_HOST line missing, empty value",
          st == 200 and pu.get("missing") == ["WEB3_MONGO_HOST_TYPO"] and mh and mh[0].get("status") == "missing"
          and "MONGO_HOST=\n" in pu.get("content", ""), (st, pu.get("missing"), mh))
    env_unh = pu.get("content", "") if st == 200 else ""

    # B10 build v2
    run("docker", "save", "busybox:latest", "-o", PRELOAD)
    st, job = bp_build(bp, "v2", env_v2)
    ok = check("B10 build v2 from GitLab: success, 7 steps", st == 201 and job.get("status") == "success"
               and len(job.get("steps", [])) == 7,
               (st, job.get("error") if isinstance(job, dict) else job,
                [(s["name"], s["status"], s["message"]) for s in job.get("steps", [])] if isinstance(job, dict) else None))
    if not ok:
        return None
    env = job.get("env") or {}
    check("B10 job.env names only, .env file removed after build",
          env.get("path") == ".env" and env.get("keys") == ENV_KEYS and env.get("count") == 5 and env.get("source") == "gitlab"
          and "content" not in env and not (env.get("written") and os.path.exists(env["written"])), env)
    check("B10 healthcheck true, preload_tars set", job.get("healthcheck") is True and job.get("preload_tars") == [PRELOAD],
          (job.get("healthcheck"), job.get("preload_tars")))
    log = J(bp, "GET", f"/api/jobs/{job['id']}/log")[1]
    check("B10 log: docker load -i <preload>, wrote .env (5 keys, found .deploy/healthcheck.sh",
          f"docker load -i {PRELOAD}" in log and "wrote .env (5 keys" in log and "found .deploy/healthcheck.sh" in log,
          log[-800:])
    rp = job["artifacts"].get("remote_path") or ""
    check("B10 remote_path smb://127.0.0.1:<smb>/releases/gl/sdtest-web3_",
          rp.startswith(f"smb://127.0.0.1:{SMB['port']}/releases/gl/sdtest-web3_"), rp)

    # B11 zip on the share
    name = os.path.basename(rp)
    zp = os.path.join(GL_DIR, name)
    check("B11 zip on disk owned by host uid, no .part left", os.path.isfile(zp) and os.stat(zp).st_uid == os.getuid()
          and not [f for f in os.listdir(GL_DIR) if f.endswith(".part")], (zp, os.listdir(GL_DIR) if os.path.isdir(GL_DIR) else None))
    folder = name[:-4]
    tar_bytes = None
    try:
        with pyzipper.AESZipFile(zp) as z:
            z.setpassword(ZIP_PW.encode())
            names = z.namelist()
            tars = [n for n in names if n.startswith(folder + "/") and n.endswith(".tar") and n.count("/") == 1]
            gitcfg = z.read(f"{folder}/mock-web3/.git/config").decode() if f"{folder}/mock-web3/.git/config" in names else ""
            tar_bytes = z.read(tars[0]) if tars else None
        check("B11 zip: <folder>/<tar>, <folder>/.deploy/healthcheck.sh, no <folder>/mock-web3/.env",
              tars and f"{folder}/.deploy/healthcheck.sh" in names and f"{folder}/mock-web3/.env" not in names, names[:20])
        check("B11 .git/config has no token", not re.search(r"glpat|gloat|oauth2:", gitcfg), gitcfg)
    except (OSError, RuntimeError, KeyError, zipfile.BadZipFile) as e:
        check("B11 zip opens with ZIP_PW", False, e)

    # B12 the image carries the .env (0644)
    found = None
    if tar_bytes:
        with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as t:
            for m in t.getmembers():
                if not m.isfile() or m.size < 512:
                    continue
                try:
                    with tarfile.open(fileobj=io.BytesIO(t.extractfile(m).read()), mode="r:*") as lt:
                        e = next((x for x in lt.getmembers() if x.name.lstrip("./") == "app/.env"), None)
                        if e:
                            found = (lt.extractfile(e).read().decode(), e.mode & 0o777)
                except (tarfile.TarError, EOFError, OSError):
                    continue
    check("B12 an image layer holds app/.env = the generated content, mode 0644", found == (env_v2, 0o644), found)

    # B13 no secrets in job json / log (SSE replay kept for D22)
    RESP.extend(d for _, d in bp.sse(f"/api/jobs/{job['id']}/logs/stream", timeout=60))
    check("B13 job json and log hold no secret", not leaks(json.dumps(job) + log), leaks(json.dumps(job) + log))

    # B14 unhealthy build
    st, job_u = bp_build(bp, "unhealthy", env_unh or "MONGO_HOST=\n")
    check("B14 build unhealthy: success + uploaded", st == 201 and job_u.get("status") == "success"
          and (job_u.get("artifacts") or {}).get("remote_path"), (st, job_u.get("error") if isinstance(job_u, dict) else job_u))

    # B14b broken build (container exits): D15c covers a service-update/converge failure in registry mode
    st, job_b = bp_build(bp, "broken", env_v2)
    check("B14b build broken: success + uploaded", st == 201 and job_b.get("status") == "success"
          and (job_b.get("artifacts") or {}).get("remote_path"), (st, job_b.get("error") if isinstance(job_b, dict) else job_b))

    # B16 data dir private (tokens, .env files, image tars)
    check("B16 BP data dir mode 700", oct(os.stat(os.path.join(bp_dir, "data")).st_mode & 0o777) == "0o700")

    # B15 import-env
    st, r = J(bp, "POST", "/api/config/import-env", {"content": "SD_TARGET_PORT=1\nFILE_SERVER_REMOTE_DIR=/gl"})
    check("B15 import-env: set upload.remote_dir, ignored SD_TARGET_PORT, names only",
          st == 200 and r.get("set") == ["upload.remote_dir"] and r.get("ignored") == ["SD_TARGET_PORT"]
          and "/gl" not in json.dumps(r), (st, r))
    return {"v2": job, "unhealthy": job_u, "broken": job_b}


# ---------------------------------------------------------------- Swarm Deployer (D)

def sd_env_file(env_dir):
    p = os.path.join(env_dir, "sd.env")
    write_env(p, "\n".join([
        f"GITLAB_URL={GL_URL}", f"GITLAB_CLIENT_ID={GL['client_id']}", f"GITLAB_CLIENT_SECRET={GL['client_secret']}",
        "FILE_SERVER_PROTOCOL=smb", "FILE_SERVER_HOST=127.0.0.1", f"FILE_SERVER_PORT={SMB['port']}",
        "FILE_SERVER_USER=files", f"FILE_SERVER_PASSWORD={FILES_PASS}", "FILE_SERVER_SHARE=releases",
        "FILE_SERVER_REMOTE_DIR=/gl", "SD_TARGET_ID=lab", f"SD_TARGET_PORT={ENV['target']['port']}",
        "SD_TARGET_HOST=127.0.0.1", "SD_TARGET_USER=deploy", "SD_WORK_DIR=/home/deploy/sd-gl-work",
        "SD_BACKUP_DIR=/home/deploy/sd-gl-backups", "SD_HOST_KEY_POLICY=auto_add", "SD_CONVERGE_TIMEOUT=90",
        "SD_UPDATE_MONITOR=5", "SD_HEALTH_TIMEOUT=20", "SD_KEEP_BACKUPS=5", "BP_UPLOAD_ENABLED=true", ""]))
    return p


def sd_deploy(sd, path, pw=ZIP_PW):
    st, job = J(sd, "POST", "/api/deploys", {"package_path": path, "password": pw})
    if st != 201:
        return st, job, []
    events = sd.sse(f"/api/deploys/{job['id']}/logs/stream")
    RESP.extend(d for _, d in events)
    return st, J(sd, "GET", f"/api/deploys/{job['id']}")[1], events


def sd_log(sd, job):
    return J(sd, "GET", f"/api/deploys/{job['id']}/log")[1]


def cfg_of(sd):
    return J(sd, "GET", "/api/config")[1]


def mapping(cfg, pkg="sdtest-web3"):
    return next((m for m in cfg.get("mappings", []) if m.get("package") == pkg), {})


def target(cfg, tid="lab"):
    return next((t for t in cfg.get("targets", []) if t.get("id") == tid), {})


def phase_sd_auth(sd):
    # D1 gate
    codes = [J(sd, "GET", p)[0] for p in ("/api/config", "/api/packages", "/api/deploys/" + "0" * 32 + "/logs/stream")]
    check("D1 gate: /api/config, /api/packages, SSE stream -> 401 before sign-in", codes == [401, 401, 401], codes)
    st, s = J(sd, "GET", "/api/auth/status")
    check("D1 status open: logged_in false, oauth_available, gitlab_url = mock",
          st == 200 and s.get("logged_in") is False and s.get("oauth_available") is True and s.get("gitlab_url") == GL_URL, s)

    # D3 PAT
    st, r = J(sd, "POST", "/api/auth/gitlab/token", {"token": "glpat-not-a-real-token", "url": GL_URL})
    check("D3 bad PAT -> 401", st == 401, (st, r))
    rurl, hits, srvs = redirect_probe()
    st, r = J(sd, "POST", "/api/auth/gitlab/token", {"token": "glpat-redirect-probe", "url": rurl})
    for srv in srvs:
        srv.shutdown()
    check("D3 a GitLab answering 302 to another host: sign-in refused, token never sent there",
          st != 200 and not hits and J(sd, "GET", "/api/auth/status")[1].get("gitlab_url") == GL_URL, (st, r, hits))
    st, r = J(sd, "POST", "/api/auth/gitlab/token", {"token": GITLAB_PAT, "url": GL_URL})
    check("D3 good PAT -> 200 sdtest-dev, /api/config 200", st == 200 and r.get("login") == "sdtest-dev"
          and J(sd, "GET", "/api/config")[0] == 200, (st, r))
    J(sd, "POST", "/api/auth/logout", {})
    check("D3 logout locks the gate again", J(sd, "GET", "/api/config")[0] == 401)

    # D4 OAuth
    mock("POST", "/_mock/reset", {})
    final, hops = oauth(sd)
    a = qs_of(hops[0][1])
    check("D4 OAuth+PKCE through redirects -> /#/dashboard, redirect_uri on the SD port",
          final.endswith("/#/dashboard") and a.get("redirect_uri") == f"http://127.0.0.1:{sd.port}/api/auth/gitlab/callback"
          and a.get("code_challenge_method") == "S256", hops)
    st, s = J(sd, "GET", "/api/auth/status")
    check("D4 status method oauth, login sdtest-dev", s.get("method") == "oauth" and s.get("login") == "sdtest-dev", s)
    st, cfg = J(sd, "GET", "/api/config")
    g = cfg.get("gitlab", {}) if st == 200 else {}
    body = json.dumps(cfg)
    check("D4 config.gitlab: has_token, url = mock, client_id_source settings, no token/secret in body",
          g.get("has_token") is True and g.get("url") == GL_URL and g.get("client_id_source") == "settings"
          and not any(p in body for p in TOKEN_PREFIXES) and GL["client_secret"] not in body, g)

    # D2 startup import (visible now that we're signed in)
    fs, tg, op = cfg.get("file_server", {}), target(cfg), cfg.get("options", {})
    check("D2 .env startup import: env_import.sha, smb file server, target lab, options",
          (cfg.get("env_import") or {}).get("sha") and fs.get("protocol") == "smb" and fs.get("share") == "releases"
          and fs.get("remote_dir") == "/gl" and fs.get("has_password") is True and tg.get("port") == ENV["target"]["port"]
          and tg.get("host") == "127.0.0.1" and tg.get("work_dir") == "/home/deploy/sd-gl-work"
          and tg.get("backup_dir") == "/home/deploy/sd-gl-backups" and op.get("converge_timeout") == 90,
          (cfg.get("env_import"), fs, tg, op))

    # D4b refresh
    mock("POST", "/_mock/ttl", {"seconds": 2})
    oauth(sd)
    time.sleep(3)
    st, r = J(sd, "GET", "/api/gitlab/projects")
    check("D4b refresh: projects 200 after expiry, mock saw a refresh_token grant", st == 200 and grants("refresh_token"),
          (st, r))
    # D4c rejected refresh re-locks
    mock("POST", "/_mock/revoke", {})
    time.sleep(3)
    st, r = J(sd, "GET", "/api/gitlab/projects")
    st2 = J(sd, "GET", "/api/config")[0]
    s = J(sd, "GET", "/api/auth/status")[1]
    check("D4c rejected refresh -> 401, gate locked, logged_in false", st == 401 and st2 == 401 and s.get("logged_in") is False,
          (st, r, st2, s))
    mock("POST", "/_mock/ttl", {"seconds": 7200})
    final, hops = oauth(sd)
    check("D4c OAuth again -> /#/dashboard", final.endswith("/#/dashboard"), hops)
    # D4d URL swap refused
    st, r = J(sd, "POST", "/api/auth/gitlab/token", {"token": GITLAB_PAT, "url": "http://127.0.0.1:9"})
    s = J(sd, "GET", "/api/auth/status")[1]
    check("D4d URL swap while signed in -> 409, still the mock + oauth",
          st == 409 and s.get("gitlab_url") == GL_URL and s.get("method") == "oauth", (st, r, s))


def phase_sd_setup(sd, sd_data):
    # D5 Import .env (CRLF)
    st, r = J(sd, "POST", "/api/config/import-env", {"content": "SD_KEEP_BACKUPS=3\r\nBOGUS_KEY=1\r\n"})
    kb = cfg_of(sd).get("options", {}).get("keep_backups")
    check("D5 import-env CRLF: set options.keep_backups, ignored BOGUS_KEY, value 3",
          st == 200 and r.get("set") == ["options.keep_backups"] and r.get("ignored") == ["BOGUS_KEY"] and kb == 3, (st, r, kb))
    J(sd, "PUT", "/api/config/options", {"keep_backups": 5})

    # D6 Import from GitLab project
    st, r = J(sd, "POST", "/api/config/import-gitlab", {"project": PROJECT})
    want = {"targets.lab.private_key_path", "targets.lab.registry.url", "targets.lab.registry.username",
            "targets.lab.registry.password", "mappings.sdtest-web3.swarm_service", "mappings.sdtest-web3.image_repo",
            "mappings.sdtest-web3.health_url"}
    check("D6 import-gitlab: 200, set covers key/registry/mapping",
          st == 200 and want <= set(r.get("set", [])), (st, r))
    check("D6 hidden ZIP_PASSWORD reported", r.get("errors") == ["ZIP_PASSWORD is hidden in GitLab; its value can't be read"],
          r.get("errors"))
    check("D6 response holds no secret value and no key", not leaks(json.dumps(r)) and "BEGIN OPENSSH" not in json.dumps(r),
          leaks(json.dumps(r)))
    kp = os.path.join(sd_data, "keys", "lab")
    norm = lambda t: t.replace("\r\n", "\n").rstrip("\n")  # noqa: E731
    check("D6 SD_DATA/keys/lab mode 600 = the lab key", os.path.isfile(kp) and oct(os.stat(kp).st_mode & 0o777) == "0o600"
          and norm(open(kp).read()) == norm(open(ENV["target"]["key_path"]).read()), kp)
    cfg = cfg_of(sd)
    m, tg = mapping(cfg), target(cfg)
    check("D6 mapping sdtest-web3 moving_tag @current (registry default), target registry 127.0.0.1:5050 + password",
          m.get("moving_tag") == "@current" and m.get("swarm_service") == "sdtest_web3" and m.get("image_repo") == WEB3
          and (tg.get("registry") or {}).get("url") == "127.0.0.1:5050" and (tg.get("registry") or {}).get("has_password") is True,
          (m, tg.get("registry")))

    # D7 tests
    st, r = J(sd, "POST", "/api/config/file-server/test", {})
    check("D7 SMB file server test ok", st == 200 and r.get("ok") and str(r.get("message", "")).startswith("Connected to smb://127.0.0.1:")
          and "/releases" in r.get("message", ""), r)
    st, r = J(sd, "POST", "/api/targets/lab/test", {})
    check("D7 target test ok, swarm manager", st == 200 and r.get("ok") and r.get("swarm_manager"), r)

    # D7b a saved password never follows a changed host / registry URL
    st, r = J(sd, "PUT", "/api/targets/lab", {"registry": {"url": "127.0.0.1:5051"}})
    reg = target(cfg_of(sd)).get("registry") or {}
    check("D7b registry URL change without a password -> 400, saved registry unchanged",
          st == 400 and "required when a registry is set" in str(r) and reg.get("url") == "127.0.0.1:5050" and reg.get("has_password"), (st, r, reg))
    st, r = J(sd, "PUT", "/api/config/file-server", {"host": "localhost"})
    st2, r2 = J(sd, "PUT", "/api/config/file-server", {"host": "127.0.0.1", "password": FILES_PASS})
    check("D7b file server host change drops the saved password; re-entered it is kept",
          st == 200 and r.get("has_password") is False and st2 == 200 and r2.get("has_password") is True, (r, r2))
    check("D7b SD data dir mode 700", oct(os.stat(sd_data).st_mode & 0o777) == "0o700")


def phase_sd_deploy(sd, builds):
    v2, unh = builds["v2"], builds["unhealthy"]
    # D8 watch listing
    st, r = J(sd, "GET", "/api/packages")
    grp = next((g for g in r.get("groups", []) if g.get("service") == "sdtest-web3"), {}) if st == 200 else {}
    names = [p["name"] for p in grp.get("packages", [])]
    want = [os.path.basename(unh["artifacts"]["remote_path"]), os.path.basename(v2["artifacts"]["remote_path"])]
    check("D8 packages /gl: sdtest-web3 group, both BP zips, format packager, modified_at, newest (unhealthy) first",
          [n for n in names if n in want] == want and all(p.get("format") == "packager" and p.get("modified_at") for p in grp.get("packages", [])[:2]),
          (names, grp))

    prev_digest = reg_digest("dev")
    # D9 deploy v2
    st, job, events = sd_deploy(sd, v2["artifacts"]["remote_path"])
    if not check("D9 deploy v2 by smb:// URL: 201, triggered_by sdtest-dev", st == 201 and job.get("triggered_by") == "sdtest-dev",
                 (st, job)):
        return None
    ph = phases(job)
    check("D9 SSE log+status+end", {"log", "status", "end"} <= {e for e, _ in events}, {e for e, _ in events})
    check("D9 success, 10 phases success", job["status"] == "success" and len(ph) == 10 and set(ph.values()) == {"success"},
          (job.get("error"), ph))
    log = sd_log(sd, job)
    ver, ts = job.get("version"), job.get("ts")
    # D10 folders
    jd = (job.get("artifacts") or {}).get("job_dir")
    check("D10 job dir W/sdtest-web3/<version> created and removed",
          jd == f"/home/deploy/sd-gl-work/sdtest-web3/{ver}" and f"mkdir -p -- {jd}" in log
          and texec("test", "-e", jd or "/nonexistent-x").returncode != 0, jd)
    bk = job.get("backup") or {}
    bd = bk.get("dir") or "/nonexistent-x"
    spec_txt = texec("cat", f"{bd}/service.json").stdout
    img_txt = texec("cat", f"{bd}/image.txt").stdout
    try:
        json.loads(spec_txt)
        spec_ok = prev_digest and prev_digest in spec_txt
    except ValueError:
        spec_ok = False
    check("D10 backup dir B/sdtest_web3/<ts>: service.json (prev digest), image.txt, image.tar, meta.json",
          bd == f"/home/deploy/sd-gl-backups/sdtest_web3/{ts}" and spec_ok
          and f"image={WEB3}:dev@{prev_digest}" in img_txt.splitlines() and f"digest={prev_digest}" in img_txt.splitlines()
          and texec("test", "-s", f"{bd}/image.tar").returncode == 0 and texec("test", "-s", f"{bd}/meta.json").returncode == 0,
          (bd, img_txt, spec_ok))
    # D11 tags + registry
    nd = job.get("new_digest")
    check("D11 previous_ref @prev digest, moving_image :dev, registry, pushed backup/version/dev in order",
          str(job.get("previous_ref")).endswith("@" + str(prev_digest)) and job.get("moving_image") == f"{WEB3}:dev"
          and job.get("registry") == "127.0.0.1:5050"
          and job.get("pushed") == [f"{WEB3}:backup-{ts}", f"{WEB3}:{ver}", f"{WEB3}:dev"],
          (job.get("previous_ref"), job.get("moving_image"), job.get("registry"), job.get("pushed")))
    i_hc, i_push = log.find("healthcheck: OK"), log.find(f"pushed {WEB3}:dev")
    check("D11 moving tag pushed after the health script passed (AD-7)", 0 <= i_hc < i_push, (i_hc, i_push))
    check("D11 registry dev == version == new_digest != prev; backup tag == prev == backup.digest",
          nd and reg_digest("dev") == reg_digest(ver) == nd != prev_digest
          and reg_digest(f"backup-{ts}") == prev_digest == bk.get("digest"),
          (reg_digest("dev"), reg_digest(ver), nd, prev_digest, reg_digest(f"backup-{ts}"), bk.get("digest")))
    check("D11 local :<version> tag dropped, :dev = the new image",
          tiid(f"{WEB3}:{ver}") is None and tiid(f"{WEB3}:dev") and tiid(f"{WEB3}:dev") == tiid(f"{WEB3}@{nd}"),
          (tiid(f"{WEB3}:{ver}"), tiid(f"{WEB3}:dev"), tiid(f"{WEB3}@{nd}")))
    # D12 service
    check("D12 service spec = deploy_image = :dev@new_digest", spec_image() == job.get("deploy_image") == f"{WEB3}:dev@{nd}",
          (spec_image(), job.get("deploy_image")))
    check("D12 log: --with-registry-auth, docker login via stdin, no registry password",
          "--with-registry-auth" in log and "docker login --username sdtest-reg --password-stdin 127.0.0.1:5050" in log
          and REG["password"] not in log, log[-400:])
    # D13 health script
    check("D13 health script ran with --url/--service and passed", job.get("health_script") is True
          and "running health script" in log and "healthcheck.sh --url=http://127.0.0.1:8084/health --service=sdtest_web3" in log
          and "healthcheck: OK" in log, job.get("health_script"))
    # D14 .env in the running app
    cfgtxt = web3("/config")
    check("D14 web3 v2 healthy, .env values in the app", web3("/version") == "web3 v2" and web3("/health") == "ok"
          and "GREETING=hello from project var" in cfgtxt and "MONGO_HOST=mongo.sdtest.local" in cfgtxt, cfgtxt)

    # D15 unhealthy -> rollback to the v2 digest
    v2d = nd
    st, ju, _ = sd_deploy(sd, unh["artifacts"]["remote_path"])
    pu, lu = phases(ju), sd_log(sd, ju) if st == 201 else ""
    rb = ju.get("rollback") or {}
    check("D15 unhealthy: verify failed (health script failed), rollback ok by previous_digest",
          pu.get("verify") == "failed" and "health script failed" in str(ju.get("error")) and rb.get("ok")
          and rb.get("method") == "previous_digest" and str(ju.get("error")).endswith(f"rolled back to {WEB3}:dev@{v2d}"),
          (ju.get("error"), rb))
    check("D15 registry :dev never moved, spec back on v2 digest, v2 serves",
          reg_digest("dev") == v2d and f"{WEB3}:dev" not in (ju.get("pushed") or []) and spec_image().endswith("@" + v2d)
          and web3("/version") == "web3 v2" and web3("/health") == "ok", (reg_digest("dev"), ju.get("pushed"), spec_image()))
    check("D15 log has rollback lines and no moving-tag push", "==> [rollback]" in lu and f"pushed {WEB3}:dev" not in lu,
          lu[-500:])

    # D15c broken (tasks exit): swarm/converge failure in registry mode, restore by digest
    br = builds.get("broken") or {}
    if (br.get("artifacts") or {}).get("remote_path"):
        st, jx, _ = sd_deploy(sd, br["artifacts"]["remote_path"])
        rbx = jx.get("rollback") or {}
        check("D15c broken: deploy/verify failed, rollback ok, error ends 'rolled back to :dev@<v2 digest>'",
              "failed" in (phases(jx).get("deploy"), phases(jx).get("verify")) and rbx.get("ok")
              and rbx.get("method") in ("swarm_auto", "previous_digest")
              and str(jx.get("error")).endswith(f"rolled back to {WEB3}:dev@{v2d}"), (jx.get("error"), rbx))
        check("D15c registry :dev unchanged, no :dev push, spec back on v2 digest, v2 serves",
              reg_digest("dev") == v2d and f"{WEB3}:dev" not in (jx.get("pushed") or []) and spec_image().endswith("@" + v2d)
              and web3("/version") == "web3 v2", (reg_digest("dev"), jx.get("pushed"), spec_image()))
        check("D15c failed registry deploy drops its local :<version> tag", tiid(f"{WEB3}:{jx.get('version')}") is None,
              tiid(f"{WEB3}:{jx.get('version')}"))
    else:
        check("D15c broken build available", False)

    # D15b health script without health_url
    m = mapping(cfg_of(sd))
    J(sd, "PUT", "/api/mappings/sdtest-web3", {**m, "health_url": ""})
    before = spec_image()
    st, jb, _ = sd_deploy(sd, v2["artifacts"]["remote_path"])
    pb = phases(jb)
    check("D15b health script but no health_url: extract failed before the target, connect skipped",
          pb.get("extract") == "failed" and pb.get("connect") == "skipped"
          and "package has .deploy/healthcheck.sh but no health_url is set" in str(jb.get("error")) and spec_image() == before,
          (jb.get("error"), pb))
    J(sd, "PUT", "/api/mappings/sdtest-web3", m)
    return {"job9": job, "prev_digest": prev_digest, "v2_digest": v2d}


def build_tarzip():
    """build_tar.sh -f exactly: docker build -t <name>, docker save -o <name>.tar <name>, zip -j -P (ZipCrypto, flat)."""
    for img in list(HOST_IMAGES):  # docker save <name> stores every tag of the repo: drop the BP-built ones first
        if img.startswith("sdtest-web3:"):
            run("docker", "rmi", img)
            HOST_IMAGES.discard(img)
    d = tempfile.mkdtemp(prefix="gl-tarzip-", dir=L)
    src = os.path.join(d, "sdtest-web3")
    os.makedirs(src)
    r = run("sh", "-c", f"git -C '{ENV['repos']['mock-web3']}' archive v2 | tar -x -C '{src}'")
    write_env(os.path.join(src, ".env"), EXPECTED_ENV)
    os.chmod(os.path.join(src, ".env"), 0o644)
    HOST_IMAGES.add("sdtest-web3:latest")
    b = run("docker", "build", "-q", "-t", "sdtest-web3", src)
    tar = os.path.join(d, "sdtest-web3.tar")
    s = run("docker", "save", "-o", tar, "sdtest-web3")
    z = run("zip", "-j", "-q", "-P", ZIP_PW, tar + ".zip", tar)
    ok = r.returncode == b.returncode == s.returncode == z.returncode == 0
    return ok, d, tar, tar + ".zip", (r.stderr, b.stderr, s.stderr, z.stderr)


def wait_pkg(sd, name, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        st, r = J(sd, "GET", "/api/packages?path=/gl")
        for g in r.get("groups", []) if st == 200 else []:
            for p in g.get("packages", []):
                if p["name"] == name:
                    return p
        time.sleep(1)
    return None


def phase_sd_tarzip(sd, info):
    # D16 build_tar.sh-style zip appears in the watch
    ok, d, tar, zp, err = build_tarzip()
    if not check("D16 build_tar.sh-style image + ZipCrypto flat zip built on the host", ok, err):
        return None
    J(sd, "GET", "/api/packages?path=/gl")
    shutil.copy(zp, os.path.join(GL_DIR, "sdtest-web3.tar.zip"))
    p = wait_pkg(sd, "sdtest-web3.tar.zip")
    check("D16 watch: sdtest-web3.tar.zip appears within 15 s, format tarzip, ts null, modified_at",
          p and p.get("format") == "tarzip" and p.get("ts") is None and p.get("modified_at"), p)
    path = "/gl/sdtest-web3.tar.zip"
    # D17 wrong password
    st, j17, _ = sd_deploy(sd, path, pw="wrong-zip-password")
    check("D17 tarzip wrong password -> extract failed", phases(j17).get("extract") == "failed"
          and "wrong zip password" in str(j17.get("error")), (j17.get("error"), phases(j17)))
    # D18 right password
    had_latest = tiid("sdtest-web3:latest")
    st, j18, _ = sd_deploy(sd, path)
    l18 = sd_log(sd, j18) if st == 201 else ""
    check("D18 tarzip deploy success: format tarzip, loaded sdtest-web3:latest, version = job ts, new_image :<ts>",
          j18.get("status") == "success" and j18.get("package_format") == "tarzip"
          and j18.get("loaded_image") == "sdtest-web3:latest" and j18.get("version") == j18.get("ts")
          and j18.get("new_image") == f"{WEB3}:{j18.get('ts')}", (j18.get("error"), phases(j18), j18.get("loaded_image")))
    check("D18 registry dev = new digest, web3 v2, extract progress logged",
          reg_digest("dev") == j18.get("new_digest") and web3("/version") == "web3 v2" and "extracted" in l18,
          (reg_digest("dev"), j18.get("new_digest"), web3("/version")))
    lt = j18.get("load_tags") or {}
    check("D18 load_tags recorded sdtest-web3:latest and cleanup put it back (absent again)",
          any("sdtest-web3:latest" in v for v in lt.values()) and had_latest is None and tiid("sdtest-web3:latest") is None,
          (lt, had_latest, tiid("sdtest-web3:latest")))
    return {"tar": tar, "zip": zp, "dir": d}


def phase_sd_rollback(sd, info):
    # D19 backups API + manual rollback to the D9 backup (previous = v1)
    st, bks = J(sd, "GET", "/api/services/sdtest-web3/backups")
    check("D19 backups: layout new, in_registry, dirs under sd-gl-backups/sdtest_web3/",
          st == 200 and bks and all(b.get("layout") == "new" and b.get("in_registry") is True
                                    and b.get("dir", "").startswith("/home/deploy/sd-gl-backups/sdtest_web3/") for b in bks), bks)
    bid = (info["job9"].get("backup") or {}).get("id")
    st, rb = J(sd, "POST", "/api/rollbacks", {"package": "sdtest-web3", "backup_id": bid})
    if st == 201:
        sd.sse(f"/api/deploys/{rb['id']}/logs/stream")
        rb = J(sd, "GET", f"/api/deploys/{rb['id']}")[1]
    pd = info["prev_digest"]
    check("D19 manual rollback to v1: 5 phases success, deploy_image :dev@v1 digest, triggered_by",
          st == 201 and rb.get("status") == "success" and len(rb.get("phases", [])) == 5
          and rb.get("deploy_image") == f"{WEB3}:dev@{pd}" and rb.get("triggered_by") == "sdtest-dev",
          (st, rb.get("error") if isinstance(rb, dict) else rb, rb.get("deploy_image") if isinstance(rb, dict) else None))
    check("D19 web3 v1, registry dev = v1 digest", web3("/version") == "web3 v1" and reg_digest("dev") == pd,
          (web3("/version"), reg_digest("dev"), pd))


def phase_sd_recovery(sd, sd_data, sd_env, tz, info):
    # D20 AES flat <name>.zip, SIGKILL during verify, recovery in registry mode
    zp = os.path.join(GL_DIR, "sdtest-web3.zip")
    with pyzipper.AESZipFile(zp, "w", compression=pyzipper.ZIP_STORED, encryption=pyzipper.WZ_AES) as z:
        z.setpassword(ZIP_PW.encode())
        z.write(tz["tar"], "sdtest-web3.tar")
    st, job = J(sd, "POST", "/api/deploys", {"package_path": "/gl/sdtest-web3.zip", "password": ZIP_PW})
    if not check("D20 AES flat sdtest-web3.zip deploy accepted", st == 201, (st, job)):
        return sd
    end, ph = time.time() + 300, {}
    while time.time() < end and ph.get("verify") not in ("running", "success", "failed"):
        ph = phases(sd.j("GET", f"/api/deploys/{job['id']}")[1])
        time.sleep(0.2)
    os.kill(sd.proc.pid, signal.SIGKILL)
    sd.proc.wait()
    check("D20 server SIGKILLed during verify", ph.get("verify") == "running", ph)
    sd = App("gl-sd2", SD_PY, ROOT, sd_env, "/api/auth/status")  # stays signed in: the token is in config.json
    st, r = J(sd, "POST", "/api/deploys", {"package_path": "/gl/sdtest-web3.zip", "password": ZIP_PW})
    check("D20 service locked during recovery (409)", st == 409, (st, r))
    if st == 201:
        wait_done(sd, f"/api/deploys/{r['id']}")
    done = wait_done(sd, f"/api/deploys/{job['id']}")
    pd = info["prev_digest"]
    check("D20 job failed 'interrupted (server restart); rolled back to :dev@<v1 digest>'",
          done["status"] == "failed"
          and str(done.get("error")).startswith(f"interrupted (server restart); rolled back to {WEB3}:dev@{pd}"),
          done.get("error"))
    jd = (done.get("artifacts") or {}).get("job_dir") or "/nonexistent-x"
    log = sd_log(sd, done)
    # registry :dev was never pushed during the killed verify (AD-7), so it stays v1; spec/web3 prove the recovery
    check("D20 registry dev still v1 (not pushed), spec @v1, web3 v1, job dir gone, recovery + rollback logged",
          reg_digest("dev") == pd and spec_image().endswith("@" + pd) and web3("/version") == "web3 v1"
          and texec("test", "-e", jd).returncode != 0 and "==> [recovery]" in log and "==> [rollback]" in log,
          (reg_digest("dev"), spec_image(), web3("/version"), jd))
    return sd


def phase_sd_prune_auto(sd, builds, tz):
    # D21 prune_after
    J(sd, "PUT", "/api/config/options", {"prune_after": True})
    st, job, _ = sd_deploy(sd, builds["v2"]["artifacts"]["remote_path"])
    check("D21 prune_after: success, docker system prune -f logged",
          job.get("status") == "success" and "docker system prune -f" in sd_log(sd, job), (job.get("error"), phases(job)))
    J(sd, "PUT", "/api/config/options", {"prune_after": False})

    # D21b auto-deploy over SMB, format (2) overwritten in place
    st, r = J(sd, "PUT", "/api/config/auto", {"enabled": True, "password": ZIP_PW, "interval": 15, "prefix": ""})
    check("D21b auto enabled", st == 200 and r.get("enabled") is True, (st, r))
    docs = os.path.join(GL_DIR, "docs.zip")
    with zipfile.ZipFile(docs, "w") as z:
        z.writestr("readme.txt", "not a package")
    tzp = os.path.join(GL_DIR, "sdtest-web3.tar.zip")
    time.sleep(1.1)
    shutil.copy(tz["zip"], tzp)
    key = time.strftime("%Y%m%d_%H%M%S", time.localtime(os.stat(tzp).st_mtime))
    before = {j["id"] for j in J(sd, "GET", "/api/deploys")[1]}
    end, new = time.time() + 60, []
    while time.time() < end:
        new = [j for j in J(sd, "GET", "/api/deploys")[1] if j["id"] not in before]
        if new and all(j["status"] != "running" for j in new):
            break
        time.sleep(2)
    time.sleep(16)  # one more tick: still exactly one job
    new = [j for j in J(sd, "GET", "/api/deploys")[1] if j["id"] not in before]
    aj = new[0] if len(new) == 1 else {}
    aj = J(sd, "GET", f"/api/deploys/{aj['id']}")[1] if aj else {}
    check("D21b exactly one auto job: trigger/triggered_by auto, sdtest-web3 tarzip, success, web3 v2",
          len(new) == 1 and aj.get("trigger") == "auto" and aj.get("triggered_by") == "auto" and aj.get("package") == "sdtest-web3"
          and aj.get("package_format") == "tarzip" and aj.get("status") == "success" and web3("/version") == "web3 v2",
          [(j.get("package"), j.get("trigger"), j.get("status"), j.get("error")) for j in new])
    st, s = J(sd, "GET", "/api/auto/status")
    proc = s.get("processed", []) if st == 200 else []
    ent = [e for e in proc if e.get("package") == "sdtest-web3" and e.get("key") == key]
    check("D21b auto status: processed key = mtime key, version = the job's; nothing for docs",
          ent and ent[0].get("version") == aj.get("version") and not [e for e in proc if e.get("package") == "docs"]
          and not [j for j in new if j.get("package") == "docs"], (key, proc))
    J(sd, "PUT", "/api/config/auto", {"enabled": False})
    os.remove(docs)


def data_scan(dirs, allow_zip_pw_in):
    """grep -rlF each secret and prefix (not *.tar: image layers legitimately hold the .env)."""
    hits = {}
    for s in SECRETS + list(TOKEN_PREFIXES):
        for d in dirs:
            for f in run("grep", "-rlF", "--exclude=*.tar", "--", s, d).stdout.split():
                hits.setdefault(s, set()).add(f)
    bad = {s: sorted(fs) for s, fs in hits.items()
           if any(os.path.basename(f) != "config.json" for f in fs)
           or s == "sdtest-mongo-secret-42"
           or (s == ZIP_PW and any(f != allow_zip_pw_in for f in fs))}
    return bad


# ---------------------------------------------------------------- main

def main():
    _lock = lab_lock()  # noqa: F841
    safety_grep()
    snap = os.path.join(ROOT, "testenv/host_snapshot.sh")
    before = run("bash", snap, os.path.join(L, "gl_snap_before.txt"))
    r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
    check("S seed.sh --reset", r.returncode == 0, r.stdout[-500:] + r.stderr[-500:])
    prev = reg_digest("dev")
    st_u = mock("GET", "/_mock/log")[0]
    check("S lab sanity: web1/web2 v1, web3 v1 healthy, spec :dev@<registry dev digest>, mock up",
          http_get("http://127.0.0.1:18081/version") == "web1 v1" and http_get("http://127.0.0.1:18082/version") == "web2 v1"
          and web3("/health") == "ok" and web3("/version") == "web3 v1" and prev and spec_image().endswith("@" + prev)
          and st_u == 200, (web3("/version"), prev, spec_image()))
    c = http.client.HTTPConnection("127.0.0.1", GL["port"], timeout=10)
    c.request("GET", "/api/v4/user", headers={"Authorization": "Bearer " + GITLAB_PAT})
    check("S mock /api/v4/user with the PAT", c.getresponse().status == 200)
    c.close()
    shutil.rmtree(GL_DIR, ignore_errors=True)
    mock("POST", "/_mock/reset", {})

    bp_dir = tempfile.mkdtemp(prefix="gl-bp-", dir=L)
    shutil.copy(os.path.join(BP_ROOT, "app.py"), bp_dir)
    shutil.copytree(os.path.join(BP_ROOT, "backend"), os.path.join(bp_dir, "backend"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(BP_ROOT, "frontend", "dist"), os.path.join(bp_dir, "frontend", "dist"))
    write_env(os.path.join(bp_dir, "bp.env"), "\n".join([
        f"GITLAB_URL={GL_URL}", f"GITLAB_CLIENT_ID={GL['client_id']}", f"GITLAB_CLIENT_SECRET={GL['client_secret']}",
        "FILE_SERVER_PROTOCOL=smb", "FILE_SERVER_HOST=127.0.0.1", f"FILE_SERVER_PORT={SMB['port']}", "FILE_SERVER_USER=files",
        f"FILE_SERVER_PASSWORD={FILES_PASS}", "FILE_SERVER_SHARE=releases", "FILE_SERVER_REMOTE_DIR=/gl",
        "SD_TARGET_PORT=2223", ""]))
    sd_data = tempfile.mkdtemp(prefix="gl-sd-", dir=L)
    env_dir = tempfile.mkdtemp(prefix="gl-sdenv-", dir=L)
    sd_env = {**clean_env(), "SD_DATA": sd_data, "SD_ENV_FILE": sd_env_file(env_dir)}
    bp = sd = None
    tz = None
    try:
        bp = App("gl-bp", BP_PY, bp_dir, {**clean_env(), "BP_ENV_FILE": os.path.join(bp_dir, "bp.env")}, "/api/auth/status")
        print("== B: Build Packager on", bp.port, flush=True)
        builds = phase_bp(bp, bp_dir)
        if not builds or (builds["unhealthy"] or {}).get("status") != "success":
            print("B failed, stopping", flush=True)
            return
        sd = App("gl-sd", SD_PY, ROOT, sd_env, "/api/auth/status")
        print("== D: Swarm Deployer on", sd.port, flush=True)
        phase_sd_auth(sd)
        phase_sd_setup(sd, sd_data)
        info = phase_sd_deploy(sd, builds)
        if not info:
            print("D9 failed, stopping", flush=True)
            return
        print("== D16-18: build_tar.sh-style zip", flush=True)
        tz = phase_sd_tarzip(sd, info)
        print("== D19: manual rollback", flush=True)
        phase_sd_rollback(sd, info)
        if tz:
            print("== D20: restart recovery (registry mode)", flush=True)
            sd = phase_sd_recovery(sd, sd_data, sd_env, tz, info)
            print("== D21: prune_after + auto-deploy over SMB", flush=True)
            phase_sd_prune_auto(sd, builds, tz)
        # D22 secrets
        found = sorted({s for x in RESP for s in leaks(x)})
        check("D22 no secret / token prefix in any API response or SSE text (both apps)", not found, found)
        bad = data_scan([os.path.join(bp_dir, "data"), sd_data], os.path.join(sd_data, "config.json"))
        check("D22 data dirs: secrets only in config.json, no MONGO secret anywhere", not bad, bad)
        check("D22 SD_DATA/keys/lab holds the key", os.path.isfile(os.path.join(sd_data, "keys", "lab")))
        # D22b a cross-site page can't trigger body-less POSTs (Origin is not the app)
        codes = []
        for a in (sd, bp):
            c = http.client.HTTPConnection("127.0.0.1", a.port, timeout=10)
            c.request("POST", "/api/auth/logout", headers={"Origin": "http://evil.example", "Host": f"127.0.0.1:{a.port}"})
            codes.append(c.getresponse().status)
            c.close()
        check("D22b cross-site POST /api/auth/logout -> 403 in both apps, still signed in",
              codes == [403, 403] and J(sd, "GET", "/api/config")[0] == 200, codes)
        # D23 logout both
        J(sd, "POST", "/api/auth/logout", {})
        J(bp, "POST", "/api/auth/logout", {})
        check("D23 logout: SD gate locked, BP logged_in false", J(sd, "GET", "/api/config")[0] == 401
              and J(bp, "GET", "/api/auth/status")[1].get("logged_in") is False)
    except Exception:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        check("test run completed without exception", False)
    finally:
        for a in (bp, sd):
            if a:
                a.stop()
        for img in HOST_IMAGES:
            if img.startswith("sdtest-"):
                run("docker", "rmi", img)
        for p in (bp_dir, env_dir, sd_data, GL_DIR, tz and tz["dir"]):
            if p:
                shutil.rmtree(p, ignore_errors=True)
        if os.path.exists(PRELOAD):
            os.remove(PRELOAD)
        mock("POST", "/_mock/reset", {})
        r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
        check("teardown seed.sh --reset", r.returncode == 0, r.stdout[-300:] + r.stderr[-300:])
        after = run("bash", snap, os.path.join(L, "gl_snap_after.txt"))
        if before.returncode == 0 and after.returncode == 0:
            a, b = (open(os.path.join(L, f)).read() for f in ("gl_snap_before.txt", "gl_snap_after.txt"))
            check("safety: host containers unchanged", a == b, "diff gl_snap_before/after")
        passed = sum(ok for _, ok in RESULTS)
        print(f"\n{passed}/{len(RESULTS)} passed", flush=True)
        sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
