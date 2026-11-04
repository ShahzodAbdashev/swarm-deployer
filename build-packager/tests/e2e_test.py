"""End-to-end test for Build Packager. Run: .venv/bin/python tests/e2e_test.py

app.py has no data-dir env override, so the test copies app.py + backend/ + frontend/dist/ into a temp dir and runs
that copy (BASE = dirname(__file__)), which keeps the real data/ untouched.
Needs: docker (busybox:latest + atmoz/sftp), git, gh logged in, network. FTP needs pyftpdlib
(tests/requirements-test.txt).
"""
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request

import logging

import paramiko
import pyzipper

logging.getLogger("paramiko").setLevel(logging.CRITICAL + 1)  # silence readiness-probe noise
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
RESULTS, RESPONSES, SSE_TEXT = [], [], []
CLEANUP_CONTAINERS, SERVICES = [], set()
TS_RE = r"\d{8}_\d{6}"


def check(name, cond, evidence=""):
    RESULTS.append((name, bool(cond), evidence))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {evidence}"), flush=True)
    return bool(cond)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def sh(*argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True)


# ---------------------------------------------------------------- server

class Server:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="bp_e2e_")
        self.app = os.path.join(self.tmp, "app")
        os.makedirs(self.app)
        shutil.copy(os.path.join(ROOT, "app.py"), self.app)
        shutil.copytree(os.path.join(ROOT, "backend"), os.path.join(self.app, "backend"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(os.path.join(ROOT, "frontend", "dist"), os.path.join(self.app, "frontend", "dist"))  # built UI
        self.data = os.path.join(self.app, "data")
        self.port = free_port()
        env = {k: v for k, v in os.environ.items()
               if k not in ("GITHUB_CLIENT_ID", "BP_ENV_FILE") and not k.startswith("GITLAB_")}
        self.logf = open(os.path.join(self.tmp, "server.log"), "w")
        self.proc = subprocess.Popen([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(self.port)],
                                     cwd=self.app, env=env, stdout=self.logf, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if self.req("GET", "/api/auth/status", record=False)[0] == 200:
                    return
            except OSError:
                time.sleep(0.2)
        raise RuntimeError("server did not start; see " + self.logf.name)

    def req(self, method, path, body=None, record=True, timeout=60):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        data = json.dumps(body).encode() if body is not None else None
        c.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        r = c.getresponse()
        raw = r.read()
        c.close()
        if record:
            RESPONSES.append((method, path, raw))
        return r.status, dict(r.getheaders()), raw

    def j(self, method, path, body=None, **kw):
        st, h, raw = self.req(method, path, body, **kw)
        try:
            return st, json.loads(raw)
        except ValueError:
            return st, raw

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def sse(srv, jid, timeout=300):
    """Read the SSE stream to the end. Returns list of (t, event, data)."""
    c = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=timeout)
    c.request("GET", f"/api/jobs/{jid}/logs/stream")
    r = c.getresponse()
    events, ev, data = [], None, []
    ctype = r.getheader("Content-Type", "")
    while True:
        line = r.fp.readline()
        if not line:
            break
        line = line.decode("utf-8", "replace")
        SSE_TEXT.append(line)
        line = line.rstrip("\n")
        if line == "":
            if ev:
                events.append((time.time(), ev, "\n".join(data)))
            ev, data = None, []
        elif line.startswith("event: "):
            ev = line[7:]
        elif line.startswith("data: "):
            data.append(line[6:])
    c.close()
    return events, ctype


def wait_job(srv, jid, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        st, job = srv.j("GET", f"/api/jobs/{jid}")
        if job["status"] in ("success", "failed"):
            return job
        time.sleep(0.3)
    raise TimeoutError(jid)


def steps(job):
    return {s["name"]: s for s in job["steps"]}


def job_body(service, repo, branch="release", **kw):
    SERVICES.add(service.lower())
    b = {"service": service, "repo_url": repo, "branch": branch, "password": "s3cret-pw", "password_confirm": "s3cret-pw"}
    b.update(kw)
    return b


def run_job(srv, body, follow=False):
    st, job = srv.j("POST", "/api/jobs", body)
    if st != 201:
        return st, job, None
    events = None
    if follow:
        events, _ = sse(srv, job["id"])
    return st, wait_job(srv, job["id"]), events


# ---------------------------------------------------------------- fixtures

def git_repo(path, files, branch):
    os.makedirs(path)
    for n, c in files.items():
        with open(os.path.join(path, n), "w") as f:
            f.write(c)
    g = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
    sh("git", "init", "-q", "-b", branch, cwd=path)
    sh("git", "add", ".", cwd=path)
    r = sh(*g, "commit", "-q", "-m", "init", cwd=path)
    assert r.returncode == 0, r.stderr


def fixtures(tmp):
    fx = os.path.join(tmp, "fx")
    base = "busybox:latest" if sh("docker", "image", "inspect", "busybox:latest").returncode == 0 else "alpine:latest"
    main = os.path.join(fx, "svcrepo")
    git_repo(main, {"Dockerfile": f"FROM {base}\nCOPY hello.txt /hello.txt\nCMD [\"true\"]\n", "hello.txt": "hi\n"}, "release")
    extra = os.path.join(fx, "extra1")
    git_repo(extra, {"README.md": "extra repo\n"}, "main")
    nodf = os.path.join(fx, "nodf")
    git_repo(nodf, {"README.md": "no dockerfile\n"}, "release")
    return main, extra, nodf


# ---------------------------------------------------------------- sections

def ui_source():
    """All UI source text: frontend/src plus the shared @devtools/ui kit it is built from."""
    parts = []
    for root in (os.path.join(ROOT, "frontend", "src"), os.path.join(ROOT, "..", "shared-ui", "src")):
        for dp, _, fs in os.walk(root):
            parts += [open(os.path.join(dp, f)).read() for f in sorted(fs) if f.endswith((".ts", ".tsx"))]
    return "\n".join(parts)


def t_ui_and_paths(srv):
    st, h, raw = srv.req("GET", "/")
    html = raw.decode()
    check("AC-1 GET / returns 200 HTML", st == 200 and "text/html" in h.get("content-type", "") and "<html" in html, st)
    from importlib import util
    spec = util.spec_from_file_location("bp_app_routes", os.path.join(srv.app, "app.py"))
    # import the copy only to read its route table (it creates data dirs in the temp copy, harmless)
    mod = util.module_from_spec(spec)
    cwd = os.getcwd()
    os.chdir(srv.app)
    sys.path.insert(0, srv.app)  # app.py imports backend/ from its own folder
    try:
        spec.loader.exec_module(mod)
    finally:
        os.chdir(cwd)
        sys.path.remove(srv.app)
    def flat(rs):  # FastAPI keeps each included router as one entry: expand them
        for r in rs:
            yield from flat(r.original_router.routes) if hasattr(r, "original_router") else [r]
    routes = [(r.path_regex, getattr(r, "methods", set())) for r in flat(mod.app.routes)]
    # the UI is a React app: scan its TypeScript sources (and the shared kit) instead of the minified bundle
    src = ui_source()
    st_a, _, raw_a = srv.req("GET", "/" + re.search(r'src="/(assets/[^"]+\.js)"', html).group(1))
    check("UI bundle served from /assets", st_a == 200 and len(raw_a) > 10000, (st_a, len(raw_a)))
    used = set()
    for m in re.finditer(r"""['"`](/api/[^'"`]*)['"`]?""", src):
        p = re.sub(r"\$\{[^}]+\}", "X" * 32, m.group(1)).split("?")[0]
        if p.endswith("/"):
            p += "X" * 32  # string concatenation like '/api/jobs/' + id
        used.add(p)
    missing = [p for p in sorted(used) if not any(rx.match(p) for rx, _ in routes)]
    check("UI: every /api path in the UI source is served by the backend", not missing and used, f"missing={missing} used={sorted(used)}")
    check("AC-29 UI never uses innerHTML", "innerHTML" not in src and "dangerouslySetInnerHTML" not in src, "innerHTML found")
    check("UI uses EventSource and closes on end", "EventSource" in src and "addEventListener('end'" in src and "es.close()" in src)
    check("AC-28 UI validates password length/match client-side",
          "password.length < 4" in src and "password !== b.password_confirm" in src)
    local = [ln.split()[3] for ln in sh("ss", "-ltnH", f"sport = :{srv.port}").stdout.splitlines() if ln.strip()]
    check("AC-2 binds 127.0.0.1 only", local == [f"127.0.0.1:{srv.port}"], local)


def t_auth(srv):
    st, s = srv.j("GET", "/api/auth/status")
    check("AC-7 device_flow_available false without GITHUB_CLIENT_ID", st == 200 and s["device_flow_available"] is False, s)
    st, d = srv.j("POST", "/api/auth/device/start")
    check("AC-7 device/start 400 without client id", st == 400, (st, d))
    st, d = srv.j("POST", "/api/auth/token", {"token": ""})
    check("auth/token empty -> 400", st == 400, (st, d))
    st, d = srv.j("POST", "/api/auth/token", {"token": "ghp_invalidinvalidinvalidinvalid0000"})
    check("AC-5 auth/token invalid -> 401", st == 401, (st, d))
    st, d = srv.j("GET", "/api/github/repos")
    check("github/repos without token -> 401", st == 401, (st, d))
    st, d = srv.j("POST", "/api/auth/gh-cli")
    login = sh("gh", "api", "user", "--jq", ".login").stdout.strip()
    check("AC-6 auth/gh-cli 200 with gh login", st == 200 and d.get("login") == login and d.get("logged_in"), (st, d, login))
    st, s = srv.j("GET", "/api/auth/status")
    check("AC-5 status logged_in after gh-cli", s.get("logged_in") and s.get("login") == login and s.get("avatar_url"), s)
    cfg = os.path.join(srv.data, "config.json")
    check("AC-3 config.json mode 600", os.path.exists(cfg) and oct(os.stat(cfg).st_mode & 0o777) == "0o600",
          oct(os.stat(cfg).st_mode & 0o777) if os.path.exists(cfg) else "missing")
    st, repos = srv.j("GET", "/api/github/repos")
    ok = st == 200 and isinstance(repos, list) and repos and all("full_name" in r and "clone_url" in r for r in repos)
    check("AC-8 github/repos list", ok, (st, str(repos)[:200]))
    if ok:
        r0 = repos[0]
        st, br = srv.j("GET", "/api/github/branches?repo=" + r0["full_name"])
        names = [b["name"] for b in br] if st == 200 else []
        check("AC-8 github/branches includes default branch", r0["default_branch"] in names, (r0["full_name"], st, names[:10]))
    st, d = srv.j("GET", "/api/github/branches?repo=../x")
    check("AC-8 branches repo=../x -> 400", st == 400, (st, d))
    st, d = srv.j("GET", "/api/github/branches?repo=octocat/definitely-no-such-repo-xyz123")
    check("branches unknown repo -> 404", st == 404, (st, d))


def t_validation(srv, main, extra):
    base = job_body("e2e-val", main)
    cases = {
        "service -bad": {"service": "-bad"}, "service 'a b'": {"service": "a b"},
        "branch --upload-pack=x": {"branch": "--upload-pack=x"}, "branch a..b": {"branch": "a..b"},
        "password mismatch": {"password_confirm": "different"}, "password 3 chars": {"password": "abc", "password_confirm": "abc"},
        "dockerfile ../x": {"dockerfile": "../x"}, "dockerfile /abs": {"dockerfile": "/etc/passwd"},
        "repo_url -x": {"repo_url": "-xyz"}, "repo_url empty": {"repo_url": ""}, "repo_url with space": {"repo_url": "/a b"},
        "branch ends .lock": {"branch": "x.lock"},
        "dup extra names": {"extra_repos": [{"url": extra, "branch": "main", "name": "dup"}, {"url": extra, "branch": "main", "name": "dup"}]},
        "extra name == repo dir": {"extra_repos": [{"url": extra, "branch": "main", "name": "svcrepo"}]},
        "extra bad name": {"extra_repos": [{"url": extra, "branch": "main", "name": "../evil"}]},
        "build_command > 2000": {"build_command": "x" * 2001},
    }
    for label, patch in cases.items():
        st, d = srv.j("POST", "/api/jobs", {**base, **patch})
        check(f"AC-10 400 for {label}", st == 400 and isinstance(d, dict) and d.get("detail"), (st, d))
    st, jobs = srv.j("GET", "/api/jobs")
    check("validation failures create no jobs", st == 200 and jobs == [], jobs)
    for p in ("/api/jobs/" + "0" * 32, "/api/jobs/nothex", "/api/jobs/" + "0" * 32 + "/log",
              "/api/jobs/" + "0" * 32 + "/logs/stream", "/api/jobs/" + "0" * 32 + "/download/zip"):
        st, d = srv.j("GET", p)
        check(f"404 for unknown {p[:40]}", st == 404, (st, d))


def t_happy(srv, main, extra, tmp):
    body = job_body("E2e-Happy", main, extra_repos=[{"url": extra, "branch": "main"}],
                    build_command="echo HELLO_BUILD; echo '<b>x</b>'", upload=True)
    st, job = srv.j("POST", "/api/jobs", body)
    if not check("AC-11 POST /api/jobs -> 201", st == 201 and job.get("status") in ("queued", "running"), (st, job)):
        return None
    jid = job["id"]
    check("job id is 32 hex", re.fullmatch(r"[0-9a-f]{32}", jid), jid)
    events, ctype = sse(srv, jid)
    job = wait_job(srv, jid)
    s = steps(job)
    check("AC-11 job success", job["status"] == "success" and job["error"] is None, (job["status"], job["error"]))
    for n in ("prepare", "clone", "build", "save", "extra_repos", "zip"):
        check(f"AC-11 step {n} success", s[n]["status"] == "success" and s[n]["started_at"] and s[n]["finished_at"], s[n])
    check("AC-11 upload skipped: upload disabled", s["upload"]["status"] == "skipped" and s["upload"]["message"] == "skipped: upload disabled", s["upload"])
    # SSE live
    kinds = [e for _, e, _ in events]
    check("AC-20 SSE content-type text/event-stream", ctype.startswith("text/event-stream"), ctype)
    check("AC-20 SSE ends with exactly one end event last", kinds and kinds[-1] == "end" and kinds.count("end") == 1, kinds[-5:])
    stat_sets = [tuple(st["status"] for st in json.loads(d)["steps"]) for _, e, d in events if e == "status"]
    # server polls every ~0.3s, so quick steps can coalesce; require >=3 distinct snapshots incl. one mid-run
    check("AC-20 SSE status events show changing step statuses", len(set(stat_sets)) >= 3 and any("running" in x for x in stat_sets),
          f"{len(set(stat_sets))} distinct: {sorted(set(stat_sets))}")
    check("AC-20 SSE end data", events and json.loads(events[-1][2]) == {"status": "success"}, events[-1] if events else None)
    logt = [t for t, e, _ in events if e == "log"]
    check("AC-20 log events arrive over time (live)", logt and logt[-1] - logt[0] > 0.2, f"span={logt[-1] - logt[0] if logt else None}")
    # last status before end must be final
    last_status = [d for _, e, d in events if e == "status"][-1]
    check("SSE final status event before end is final", json.loads(last_status)["status"] == "success", last_status[:120])
    # folder
    fname = job["folder_name"]
    check("AC-12 folder name <service>_YYYYMMDD_HHMMSS", re.fullmatch(rf"E2e-Happy_{TS_RE}", fname) and fname == f"E2e-Happy_{job['ts']}", fname)
    F = os.path.join(srv.data, "workspace", fname)
    tname = f"E2e-Happy_{job['branch'].replace('/', '-')}_{job['ts']}.tar"
    check("tar named <service>_<branch>_<datetime>.tar", job.get("tar_name") == tname, job.get("tar_name"))
    tar = os.path.join(F, tname)
    check("AC-12 folder contains repo, extra, tar",
          all(os.path.exists(os.path.join(F, x)) for x in ("svcrepo/Dockerfile", "extra1/README.md", tname)),
          os.listdir(F) if os.path.isdir(F) else "no folder")
    check("image_tag lowercased", job["image_tag"] == "e2e-happy:" + job["ts"], job["image_tag"])
    try:
        names = tarfile.open(tar).getnames()
    except Exception as e:
        names = [repr(e)]
    check("AC-13 tar contains manifest.json", "manifest.json" in names, names[:10])
    check("AC-13 docker image inspect", sh("docker", "image", "inspect", job["image_tag"]).returncode == 0, job["image_tag"])
    check("artifacts tar flag/size", job["artifacts"]["tar"] and job["artifacts"]["tar_size"] == os.path.getsize(tar), job["artifacts"])
    # zip
    zp = os.path.join(srv.data, "workspace", fname + ".zip")
    check("artifacts zip flag/size", job["artifacts"]["zip"] and os.path.exists(zp) and job["artifacts"]["zip_size"] == os.path.getsize(zp), job["artifacts"])
    with pyzipper.AESZipFile(zp) as z:
        infos = z.infolist()
        first = next(i for i in infos if not i.is_dir())
        try:
            z.read(first.filename)
            nopw = False
        except Exception:
            nopw = True
        check("AC-14 zip read without password fails", nopw)
        z.setpassword(b"wrong-pw")
        try:
            z.read(first.filename)
            wrong = False
        except Exception:
            wrong = True
        check("AC-14 zip read with wrong password fails", wrong)
        z.setpassword(b"s3cret-pw")
        names = z.namelist()
        check("AC-14 all entries under <folder>/", names and all(n.startswith(fname + "/") for n in names), names[:5])
        # pyzipper reports the inner method (8) in compress_type; on disk it is 99 + 0x9901 extra, strength 3 = AES-256
        check("AC-14 entries WZ_AES-256 encrypted", all(i.flag_bits & 1 and i.extra[:2] == b"\x01\x99" and i.wz_aes_strength == 3
                                                       for i in infos if not i.is_dir()), {(i.compress_type, i.wz_aes_strength) for i in infos})
        raw = open(zp, "rb").read(10)
        check("AC-14 first local header compression method 99", raw[8:10] == b"\x63\x00", raw[8:10])
        check("AC-14 zip contains ONLY the image tar (no source repos)", names == [f"{fname}/{tname}"], names)
        data = z.read(f"{fname}/{tname}")
        check("AC-14 tar extracted from zip equals tar on disk", data == open(tar, "rb").read(), len(data))
    # downloads
    for kind, mime in (("zip", "application/zip"), ("tar", "application/x-tar")):
        st, h, raw = srv.req("GET", f"/api/jobs/{jid}/download/{kind}", record=False)
        cd = h.get("content-disposition", "")
        check(f"AC-15 download/{kind} 200 + filename", st == 200 and f'filename="{fname + ".zip" if kind == "zip" else tname}"' in cd and mime in h.get("content-type", "")
              and len(raw) == os.path.getsize(zp if kind == "zip" else tar), (st, cd, h.get("content-type")))
    # log
    st, h, raw = srv.req("GET", f"/api/jobs/{jid}/log")
    log = raw.decode()
    check("log endpoint text/plain", st == 200 and "text/plain" in h.get("content-type", ""), h.get("content-type"))
    for n in ("prepare", "clone", "build", "save", "extra_repos", "zip", "upload"):
        check(f"AC-22 log has started+result for {n}", f"==> [{n}] started" in log and re.search(rf"==> \[{n}\] (success|skipped|failed)", log), n)
    check("AC-22 log has $ git -c credential.helper= clone and $ docker build/save", "$ git -c credential.helper= clone" in log and "$ docker build" in log and "$ docker save" in log)
    check("AC-18 HELLO_BUILD echoed in log", "HELLO_BUILD" in log.replace("echo HELLO_BUILD", ""))
    check("AC-22 docker build output in log", re.search(r"naming to|writing image|Successfully built|DONE", log), "no build output")
    check("AC-22 last line JOB SUCCESS", log.strip().splitlines()[-1].endswith("==> JOB SUCCESS"), log.strip().splitlines()[-1])
    check("every log line has [HH:MM:SS] prefix", all(re.match(r"^\[\d\d:\d\d:\d\d\] ", ln) for ln in log.splitlines()),
          [ln for ln in log.splitlines() if not re.match(r"^\[\d\d:\d\d:\d\d\] ", ln)][:3])
    check("AC-29 <b>x</b> kept as literal text in log", "<b>x</b>" in log)
    check("zip password not in log/json", "s3cret-pw" not in log and "s3cret-pw" not in open(os.path.join(srv.data, "jobs", jid + ".json")).read())
    # AC-21 replay
    events2, _ = sse(srv, jid)
    replay = [d for _, e, d in events2 if e == "log"]
    kinds2 = [e for _, e, _ in events2]
    check("AC-21 replay of finished job = full log, then status, then end",
          replay == log.rstrip("\n").split("\n") and kinds2[-2:] == ["status", "end"], (len(replay), len(log.splitlines()), kinds2[-3:]))
    check("SSE live log == full log", [d for _, e, d in events if e == "log"] == log.rstrip("\n").split("\n"))
    st, jobs = srv.j("GET", "/api/jobs")
    check("GET /api/jobs lists job", any(x["id"] == jid for x in jobs))
    return job


def t_failures(srv, main, nodf):
    st, job, _ = run_job(srv, job_body("e2e-badbranch", main, branch="nope-branch"))
    s = steps(job)
    check("AC-16 bad branch: clone failed, job failed, error set",
          job["status"] == "failed" and s["clone"]["status"] == "failed" and job["error"] and s["prepare"]["status"] == "success", (job["status"], s["clone"], job["error"]))
    later = [s[n]["status"] for n in ("build", "save", "extra_repos", "zip", "upload")]
    check("AC-16 later steps pending", later == ["pending"] * 5, later)
    st, h, raw = srv.req("GET", f"/api/jobs/{job['id']}/log")
    check("AC-22 failed log ends with JOB FAILED", raw.decode().strip().splitlines()[-1].split("] ", 1)[1].startswith("==> JOB FAILED:"), raw[-200:])
    for kind in ("zip", "tar"):
        st, d = srv.j("GET", f"/api/jobs/{job['id']}/download/{kind}")
        check(f"AC-15 download/{kind} 409 without artifact", st == 409, (st, d))
    events, _ = sse(srv, job["id"])
    check("SSE end status failed", events and events[-1][1] == "end" and json.loads(events[-1][2]) == {"status": "failed"}, events[-1:] if events else None)

    st, job, _ = run_job(srv, job_body("e2e-nodf", nodf))
    s = steps(job)
    check("AC-17 no Dockerfile: build failed 'Dockerfile not found'", s["build"]["status"] == "failed" and "Dockerfile not found" in s["build"]["message"], s["build"])

    st, job, _ = run_job(srv, job_body("e2e-exit3", main, build_command="exit 3"))
    s = steps(job)
    check("AC-18 build_command exit 3 fails build", job["status"] == "failed" and s["build"]["status"] == "failed", s["build"])

    st, job, _ = run_job(srv, job_body("e2e-df", main, dockerfile="Missing.Dockerfile"))
    check("custom dockerfile path missing -> build failed", steps(job)["build"]["status"] == "failed" and "Missing.Dockerfile" in steps(job)["build"]["message"], steps(job)["build"])

    st, job, _ = run_job(srv, job_body("e2e-badextra", main, extra_repos=[{"url": main, "branch": "no-such", "name": "x1"}]))
    s = steps(job)
    check("extra repo bad branch -> extra_repos failed, zip pending", s["extra_repos"]["status"] == "failed" and s["zip"]["status"] == "pending", s["extra_repos"])


def t_manifest(srv, tmp):
    base = "busybox:latest" if sh("docker", "image", "inspect", "busybox:latest").returncode == 0 else "alpine:latest"
    df = f"FROM {base}\nCMD [\"true\"]\n"
    good = os.path.join(tmp, "fx", "mf-good")
    git_repo(good, {"Dockerfile": df, "deploy.yml": "service: stack_web\nimage: team/web\nhealth_url: http://127.0.0.1:8080/health\n"}, "release")
    st, job, _ = run_job(srv, job_body("e2e-mf", good))
    check("deploy.yml: job success + deploy_manifest set", job["status"] == "success"
          and job.get("deploy_manifest") == {"service": "stack_web", "image": "team/web", "health_url": "http://127.0.0.1:8080/health"},
          (job["status"], job.get("deploy_manifest")))
    check("deploy.yml: clone message names service", "deploy.yml: service stack_web" in steps(job)["clone"]["message"], steps(job)["clone"])
    with pyzipper.AESZipFile(os.path.join(srv.data, "workspace", job["folder_name"] + ".zip")) as z:
        z.setpassword(b"s3cret-pw")
        names = z.namelist()
        top = z.read(f"{job['folder_name']}/deploy.yml").decode() if f"{job['folder_name']}/deploy.yml" in names else ""
    check("deploy.yml at <folder>/deploy.yml in zip", "service: stack_web" in top, [n for n in names if "deploy" in n])
    check("deploy.yml zip = tar + deploy.yml only", sorted(names) == sorted([f"{job['folder_name']}/{job['tar_name']}", f"{job['folder_name']}/deploy.yml"]), names)
    bad_repo = os.path.join(tmp, "fx", "mf-bad")
    git_repo(bad_repo, {"Dockerfile": df, "deploy.yml": "service: stack_web\nimage: team/web\nreplicas: 3\n"}, "release")
    st, job, _ = run_job(srv, job_body("e2e-mfbad", bad_repo))
    c = steps(job)["clone"]
    check("deploy.yml unknown key -> clone failed with clear message", job["status"] == "failed" and c["status"] == "failed"
          and "unknown key(s) replicas" in c["message"], c)
    yaml_bad = os.path.join(tmp, "fx", "mf-yaml")
    git_repo(yaml_bad, {"Dockerfile": df, "deploy.yaml": "service: [unclosed\n"}, "release")
    st, job, _ = run_job(srv, job_body("e2e-mfyaml", yaml_bad))
    check("deploy.yaml invalid YAML -> clone failed", steps(job)["clone"]["status"] == "failed" and "deploy.yaml: not valid YAML" in steps(job)["clone"]["message"], steps(job)["clone"])
    st, job, _ = run_job(srv, job_body("e2e-nomf", os.path.join(tmp, "fx", "svcrepo")))
    lg = open(os.path.join(srv.data, "jobs", job["id"] + ".log")).read()
    check("no deploy.yml -> success, logged, deploy_manifest null", job["status"] == "success" and job.get("deploy_manifest") is None
          and "no deploy.yml" in lg, job.get("deploy_manifest"))


def t_token_masking(srv, real_token):
    cfgp = os.path.join(srv.data, "config.json")
    with open(cfgp) as f:
        cfg = json.load(f)
    fake = "ghp_FAKEe2eTOKEN1234567890abcdefABCDEF12"
    cfg["github_token"] = fake
    with open(cfgp, "w") as f:
        json.dump(cfg, f)
    url = "https://github.com/octocat/definitely-not-a-repo-e2e-xyz.git"
    st, job, events = run_job(srv, job_body("e2e-mask", url, branch="main"), follow=True)
    jid = job["id"]
    log = open(os.path.join(srv.data, "jobs", jid + ".log")).read()
    jj = open(os.path.join(srv.data, "jobs", jid + ".json")).read()
    sse_all = "".join(d for _, _, d in events)
    check("AC-23 fake-token job: clone failed", steps(job)["clone"]["status"] == "failed", steps(job)["clone"])
    check("AC-23 token not in log/json/SSE", fake not in log and fake not in jj and fake not in sse_all)
    check("AC-23 masked clone command shows ***", "https://x-access-token:***@github.com/octocat/" in log,
          [ln for ln in log.splitlines() if "git clone" in ln])
    check("AC-23 repo_url stored as typed", job["repo_url"] == url, job["repo_url"])
    check("zip password not in masked job files", "s3cret-pw" not in log + jj + sse_all)
    # real token too, for a public github repo clone (token injected, must be masked)
    srv.j("POST", "/api/auth/gh-cli")
    st, job, events = run_job(srv, job_body("e2e-mask2", "https://github.com/octocat/Hello-World.git", branch="master"), follow=True)
    log = open(os.path.join(srv.data, "jobs", job["id"] + ".log")).read()
    check("real token: clone of public repo works with injected token", steps(job)["clone"]["status"] == "success", steps(job)["clone"])
    check("real token masked in log/SSE", real_token not in log and real_token not in "".join(d for _, _, d in events) and "x-access-token:***@" in log)
    gitcfg = open(os.path.join(srv.data, "workspace", job["folder_name"], "Hello-World", ".git", "config")).read()
    check("token not left in cloned .git/config", real_token not in gitcfg and "x-access-token" not in gitcfg, gitcfg)
    c = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
    c.request("GET", "/api/auth/status", headers={"Host": "evil.example"})
    check("foreign Host header rejected (DNS rebinding)", c.getresponse().status == 400)
    return fake


def t_upload_config(srv):
    st, d = srv.j("GET", "/api/config/upload")
    check("upload config defaults", st == 200 and d == {"enabled": False, "protocol": "sftp", "host": "", "port": 22, "username": "",
                                                       "remote_dir": "/", "private_key_path": "", "domain": "", "share": "",
                                                       "has_password": False}, d)
    full = {"enabled": True, "protocol": "ftp", "host": "h.example", "port": 2121, "username": "u1",
            "password": "UPLOAD-PW-xyz", "remote_dir": "/a/b", "private_key_path": "/k"}
    st, d = srv.j("PUT", "/api/config/upload", full)
    exp = {k: v for k, v in full.items() if k != "password"} | {"has_password": True, "domain": "", "share": ""}
    check("AC-24 PUT round-trips fields, has_password true, no password", st == 200 and d == exp, d)
    st, d = srv.j("PUT", "/api/config/upload", {"host": "h2.example"})
    check("AC-24 omitting password keeps it", d.get("has_password") is True and d.get("host") == "h2.example" and d.get("port") == 2121, d)
    st, d = srv.j("GET", "/api/config/upload")
    check("AC-24 GET never shows password", "password" not in d and d.get("has_password") is True, d)
    for label, patch in {"protocol scp": {"protocol": "scp"}, "port 0": {"port": 0}, "port 70000": {"port": 70000},
                         "enabled without host": {"enabled": True, "host": ""}, "empty remote_dir": {"remote_dir": ""},
                         "smb without share": {"protocol": "smb", "host": "h", "share": ""}}.items():
        st, d = srv.j("PUT", "/api/config/upload", patch)
        check(f"PUT upload 400 for {label}", st == 400, (st, d))
    st, d = srv.j("PUT", "/api/config/upload", {"password": ""})
    check("PUT password '' clears it", d.get("has_password") is False, d)
    st, d = srv.j("PUT", "/api/config/upload", {"enabled": True, "protocol": "sftp", "host": "192.0.2.1", "port": 22, "password": "x"})
    t0 = time.time()
    st, d = srv.j("POST", "/api/config/upload/test", timeout=60)
    dt = time.time() - t0
    check("AC-25 test unreachable host -> 200 ok:false within ~20s", st == 200 and d.get("ok") is False and d.get("message") and dt < 22, (st, d, round(dt, 1)))
    srv.j("PUT", "/api/config/upload", {"enabled": False, "host": ""})
    st, d = srv.j("POST", "/api/config/upload/test")
    check("upload/test 400 when host empty", st == 400, (st, d))
    check("AC-3 config.json still 600 after upload save", oct(os.stat(os.path.join(srv.data, "config.json")).st_mode & 0o777) == "0o600")


def t_sftp(srv, main):
    port = free_port()
    r = sh("docker", "run", "-d", "--rm", "-p", f"127.0.0.1:{port}:22", "atmoz/sftp", "foo:pass:::upload")
    if r.returncode != 0:
        check("SFTP server container started (SKIP)", True, "skipped: " + r.stderr.strip())
        print("NOTE: atmoz/sftp not available, SFTP upload test skipped:", r.stderr.strip())
        return
    cid = r.stdout.strip()
    CLEANUP_CONTAINERS.append(cid)
    ready = False
    for _ in range(60):
        try:
            t = paramiko.Transport(("127.0.0.1", port))
            t.connect(username="foo", password="pass")
            t.close()
            ready = True
            break
        except Exception:
            time.sleep(0.5)
    if not check("SFTP server ready", ready):
        return
    st, d = srv.j("PUT", "/api/config/upload", {"enabled": True, "protocol": "sftp", "host": "127.0.0.1", "port": port,
                                                 "username": "foo", "password": "pass", "remote_dir": "/upload/e2e/deep", "private_key_path": ""})
    check("PUT sftp config", st == 200, d)
    st, d = srv.j("POST", "/api/config/upload/test")
    check("SFTP test connection ok", st == 200 and d.get("ok") is True, d)
    st, job, events = run_job(srv, job_body("e2e-sftp", main), follow=True)
    s = steps(job)
    check("AC-19 no extras -> extra_repos skipped", s["extra_repos"]["status"] == "skipped" and s["extra_repos"]["message"] == "skipped: no extra repos", s["extra_repos"])
    check("AC-26 SFTP upload success + job success", job["status"] == "success" and s["upload"]["status"] == "success", (job["status"], s["upload"]))
    name = job["folder_name"] + ".zip"
    check("AC-26 remote_path set", job["artifacts"]["remote_path"] == f"sftp://127.0.0.1:{port}/upload/e2e/deep/{name}", job["artifacts"]["remote_path"])
    try:
        t = paramiko.Transport(("127.0.0.1", port))
        t.connect(username="foo", password="pass")
        sz = paramiko.SFTPClient.from_transport(t).stat(f"/upload/e2e/deep/{name}").st_size
        t.close()
    except Exception as e:
        sz = repr(e)
    check("AC-26 remote file size == local zip", sz == job["artifacts"]["zip_size"], (sz, job["artifacts"]["zip_size"]))
    log = open(os.path.join(srv.data, "jobs", job["id"] + ".log")).read()
    check("upload progress logged (<= 11 lines)", 1 <= log.count("uploaded ") - log.count("uploaded to") <= 11, log.count("uploaded "))
    check("upload password not in log", "pass\n" not in log and ":pass@" not in log)
    # upload: false forces skip
    st, job, _ = run_job(srv, job_body("e2e-noup", main, upload=False))
    check("upload:false -> skipped 'skipped: upload disabled'", steps(job)["upload"]["status"] == "skipped" and steps(job)["upload"]["message"] == "skipped: upload disabled" and job["status"] == "success", steps(job)["upload"])
    # wrong password -> upload failed, job failed
    srv.j("PUT", "/api/config/upload", {"password": "wrongpass"})
    st, job, _ = run_job(srv, job_body("e2e-sftpbad", main))
    s = steps(job)
    check("AC-26 upload failure -> step failed, job failed", s["upload"]["status"] == "failed" and job["status"] == "failed" and job["error"], (s["upload"], job["status"]))
    srv.j("PUT", "/api/config/upload", {"enabled": False})


FTP_SERVER = r"""
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer
proto, port, root, cert = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
H = TLS_FTPHandler if proto == "ftps" else FTPHandler
a = DummyAuthorizer(); a.add_user("ftpu", "ftp-pw", root, perm="elradfmwMT")
H.authorizer = a
if proto == "ftps":
    H.certfile = cert; H.tls_control_required = True; H.tls_data_required = True
FTPServer(("127.0.0.1", port), H).serve_forever()
"""


def t_ftp(srv, main, tmp):
    if sh(PY, "-c", "import pyftpdlib").returncode != 0:
        check("FTP test (SKIP: pyftpdlib missing)", True)
        print("NOTE: pyftpdlib not installed; pip install -r tests/requirements-test.txt")
        return
    root = os.path.join(tmp, "ftproot")
    os.makedirs(root)
    cert = os.path.join(tmp, "ftp.pem")
    sh("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", cert, "-out", cert + ".crt", "-days", "1", "-subj", "/CN=localhost")
    with open(cert, "a") as f:
        f.write(open(cert + ".crt").read())
    for proto in ("ftp", "ftps"):
        port = free_port()
        p = subprocess.Popen([PY, "-c", FTP_SERVER, proto, str(port), root, cert], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), 1).close()
                break
            except OSError:
                time.sleep(0.1)
        try:
            srv.j("PUT", "/api/config/upload", {"enabled": True, "protocol": proto, "host": "127.0.0.1", "port": port,
                                                 "username": "ftpu", "password": "ftp-pw", "remote_dir": f"/drop/{proto}"})
            st, d = srv.j("POST", "/api/config/upload/test")
            check(f"{proto.upper()} test connection ok", d.get("ok") is True, d)
            st, job, _ = run_job(srv, job_body(f"e2e-{proto}", main))
            s = steps(job)
            name = job["folder_name"] + ".zip"
            remote = os.path.join(root, "drop", proto, name)
            check(f"AC-26 {proto.upper()} upload success", job["status"] == "success" and s["upload"]["status"] == "success", (job["status"], s["upload"]))
            check(f"AC-26 {proto.upper()} remote file size == zip", os.path.exists(remote) and os.path.getsize(remote) == job["artifacts"]["zip_size"],
                  os.listdir(os.path.dirname(remote)) if os.path.isdir(os.path.dirname(remote)) else "no dir")
            check(f"AC-26 {proto.upper()} remote_path", job["artifacts"]["remote_path"] == f"{proto}://127.0.0.1:{port}/drop/{proto}/{name}", job["artifacts"]["remote_path"])
            if proto == "ftp":
                # test unsaved form values: deep missing path gets created, probe file removed, settings unchanged
                st, d = srv.j("POST", "/api/config/upload/test", {"remote_dir": "/new/deep/path"})
                check("FTP test of unsaved path creates it", d.get("ok") is True and os.path.isdir(os.path.join(root, "new/deep/path"))
                      and d.get("created") == ["/new", "/new/deep", "/new/deep/path"], d)
                check("FTP test probe file removed", os.listdir(os.path.join(root, "new/deep/path")) == [], os.listdir(os.path.join(root, "new/deep/path")))
                check("FTP test did not save settings", srv.j("GET", "/api/config/upload")[1]["remote_dir"] == f"/drop/{proto}")
                st, d = srv.j("POST", "/api/config/upload/test", {"remote_dir": "/new/deep/path"})
                check("FTP test existing path -> nothing created", d.get("ok") is True and d.get("created") == [], d)
                for bad_dir in ("relative/dir", "/a/../etc", "/a\r\nDELE x"):
                    st, d = srv.j("POST", "/api/config/upload/test", {"remote_dir": bad_dir})
                    check(f"FTP test rejects remote_dir {bad_dir!r}", st == 400, (st, d))
                    st, d = srv.j("PUT", "/api/config/upload", {"remote_dir": bad_dir})
                    check(f"PUT rejects remote_dir {bad_dir!r}", st == 400, (st, d))
                # per-build full path override, created on the fly
                st, job, _ = run_job(srv, job_body("e2e-ftpdir", main, remote_dir="/per/build/dir"))
                name2 = job["folder_name"] + ".zip"
                check("per-build remote_dir upload lands in created path", job["status"] == "success"
                      and os.path.exists(os.path.join(root, "per/build/dir", name2)), (job["status"], steps(job)["upload"]))
                check("per-build remote_path reported", job["artifacts"]["remote_path"] == f"ftp://127.0.0.1:{port}/per/build/dir/{name2}", job["artifacts"]["remote_path"])
                lg = open(os.path.join(srv.data, "jobs", job["id"] + ".log")).read()
                check("created remote folders logged", "created remote folder /per/build/dir" in lg)
                st, d = srv.j("POST", "/api/jobs", job_body("e2e-ftpbad", main, remote_dir="/x/../y"))
                check("POST /api/jobs rejects bad remote_dir", st == 400 and "remote_dir" in d.get("detail", ""), (st, d))
                srv.j("PUT", "/api/config/upload", {"password": "bad"})
                st, d = srv.j("POST", "/api/config/upload/test")
                check("FTP test with wrong password -> ok:false", st == 200 and d.get("ok") is False, d)
        finally:
            p.terminate()
            p.wait()
    srv.j("PUT", "/api/config/upload", {"enabled": False})


def t_delete(srv, main, happy):
    st, job = srv.j("POST", "/api/jobs", job_body("e2e-running", main, build_command="sleep 4"))
    time.sleep(0.5)
    st, d = srv.j("DELETE", f"/api/jobs/{job['id']}")
    check("AC-30 DELETE running job -> 409", st == 409, (st, d))
    wait_job(srv, job["id"])
    if happy:
        jid, fname = happy["id"], happy["folder_name"]
        st, d = srv.j("DELETE", f"/api/jobs/{jid}")
        paths = [os.path.join(srv.data, "jobs", jid + ".json"), os.path.join(srv.data, "jobs", jid + ".log"),
                 os.path.join(srv.data, "workspace", fname), os.path.join(srv.data, "workspace", fname + ".zip")]
        check("AC-30 DELETE finished job removes json/log/folder/zip", st == 200 and d == {"deleted": True} and not any(map(os.path.exists, paths)),
              (st, d, [p for p in paths if os.path.exists(p)]))
        st, d = srv.j("GET", f"/api/jobs/{jid}")
        check("deleted job -> 404", st == 404)
    st, d = srv.j("DELETE", "/api/jobs/" + "f" * 32)
    check("DELETE unknown -> 404", st == 404, (st, d))


def t_dup_second(srv, main):
    b = job_body("e2e-dup", main, build_command="sleep 1")
    res = []

    def go():
        res.append(srv.j("POST", "/api/jobs", b)[0])
    for _ in range(3):
        ths = [threading.Thread(target=go) for _ in range(2)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        if 409 in res:
            break
        time.sleep(1.1)
    check("same service twice in same second -> one 201, one 409", 409 in res and 201 in res, res)


def t_restart_recovery(srv):
    jid = "a" * 32
    jobs = os.path.join(srv.data, "jobs")
    st, existing = srv.j("GET", "/api/jobs")
    j = dict(existing[0]) if existing else None
    if not j:
        return
    j.update(id=jid, status="running", finished_at=None, error=None, folder_name="zz_restart", created_at="2000-01-01T00:00:00")
    with open(os.path.join(jobs, jid + ".json"), "w") as f:
        json.dump(j, f)
    open(os.path.join(jobs, jid + ".log"), "w").close()
    srv.stop()
    srv.__init__restart()
    st, d = srv.j("GET", f"/api/jobs/{jid}")
    check("restart marks running job failed 'interrupted (server restart)'", d.get("status") == "failed" and d.get("error") == "interrupted (server restart)", d)


def _restart(self):
    self.port = free_port()
    env = {k: v for k, v in os.environ.items()
               if k not in ("GITHUB_CLIENT_ID", "BP_ENV_FILE") and not k.startswith("GITLAB_")}
    self.proc = subprocess.Popen([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(self.port)],
                                 cwd=self.app, env=env, stdout=self.logf, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            if self.req("GET", "/api/auth/status", record=False)[0] == 200:
                return
        except OSError:
            time.sleep(0.2)


Server.__init__restart = _restart


def t_secrets_in_responses(real_token, fake):
    leaks = [(m, p) for m, p, raw in RESPONSES if real_token.encode() in raw or fake.encode() in raw
             or b"UPLOAD-PW-xyz" in raw or b"s3cret-pw" in raw or b"ftp-pw" in raw]
    check(f"AC-4 no API response ({len(RESPONSES)}) contains token/passwords", not leaks, leaks[:5])
    sse_all = "".join(SSE_TEXT)
    check("AC-23 no SSE output contains token/zip password", real_token not in sse_all and fake not in sse_all and "s3cret-pw" not in sse_all)


def t_logout(srv):
    st, d = srv.j("POST", "/api/auth/logout")
    check("AC-9 logout -> logged_in false", st == 200 and d == {"logged_in": False}, d)
    st, s = srv.j("GET", "/api/auth/status")
    check("AC-9 status logged_in false", s["logged_in"] is False and s["login"] is None, s)
    st, d = srv.j("GET", "/api/github/repos")
    check("AC-9 repos 401 after logout", st == 401, (st, d))


def main():
    real_token = sh("gh", "auth", "token").stdout.strip()
    srv = Server()
    print(f"server on 127.0.0.1:{srv.port}, temp {srv.tmp}")
    try:
        main_repo, extra, nodf = fixtures(srv.tmp)
        t_ui_and_paths(srv)
        t_auth(srv)
        t_validation(srv, main_repo, extra)
        happy = t_happy(srv, main_repo, extra, srv.tmp)
        t_failures(srv, main_repo, nodf)
        t_manifest(srv, srv.tmp)
        fake = t_token_masking(srv, real_token)
        t_upload_config(srv)
        t_sftp(srv, main_repo)
        t_ftp(srv, main_repo, srv.tmp)
        t_dup_second(srv, main_repo)
        t_delete(srv, main_repo, happy)
        t_secrets_in_responses(real_token, fake)
        t_logout(srv)
        t_restart_recovery(srv)
    except Exception:
        import traceback
        traceback.print_exc()
        check("test run completed without exception", False, "see traceback")
    finally:
        srv.stop()
        for c in CLEANUP_CONTAINERS:
            sh("docker", "rm", "-f", c)
        out = sh("docker", "images", "--format", "{{.Repository}}:{{.Tag}}").stdout.split()
        rm = [i for i in out if i.split(":")[0] in SERVICES]
        if rm:
            sh("docker", "rmi", "-f", *rm)
        if os.environ.get("KEEP_TMP"):
            print("kept", srv.tmp)
        else:
            shutil.rmtree(srv.tmp, ignore_errors=True)
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed")
    for n, _, ev in fails:
        print(f"  FAIL {n}: {ev}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
