"""Full chain test: Build Packager (A) -> file server -> Swarm Deployer (B) -> mock swarm target.
Run: /home/shahzod/mywork/swarm-deployer/.venv/bin/python tests/full_chain_test.py
Needs the lab up (testenv/up.sh --node2, testenv/seed.sh). Swarm commands only via `docker exec sdtest-target`.
"""
import http.client
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import paramiko

logging.getLogger("paramiko").setLevel(logging.CRITICAL + 1)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP_ROOT = "/home/shahzod/mywork/build-packager"
BP_PY = os.path.join(BP_ROOT, ".venv/bin/python")
ENV = json.load(open(os.path.join(ROOT, "testenv/env.json")))
L = ENV["scratch_dir"]
FS, TG, N2 = ENV["file_server"]["sftp"], ENV["target"], ENV["node2"]
ZIP_PW = ENV["zip_password"]
CHAIN_DIR = "/releases/chain"
RESULTS = []
HOST_IMAGES = set()


def lab_lock():
    """Exclusive lock on the shared mock lab (same file as testenv/seed.sh); held until the process exits."""
    import fcntl
    f = open(os.path.join(ENV["scratch_dir"], "lab.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("waiting for lab lock (another suite is using the lab)...", flush=True)
        fcntl.flock(f, fcntl.LOCK_EX)
    os.environ["SDTEST_LAB_LOCK_HELD"] = "1"
    return f


def check(name, cond, evidence=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {str(evidence)[:600]}"), flush=True)
    return bool(cond)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def clean_env():
    """os.environ minus everything that would configure GitLab or import a .env behind the test's back."""
    return {k: v for k, v in os.environ.items()
            if k not in ("GITHUB_CLIENT_ID", "SD_ENV_FILE", "BP_ENV_FILE") and not k.startswith("GITLAB_")}


def sd_env(data):
    """Swarm Deployer env for a suite: fresh SD_DATA, SD_ENV_FILE pointing at a file that doesn't exist (no import)."""
    return {**clean_env(), "SD_DATA": data, "SD_ENV_FILE": os.path.join(data, "none.env")}


def bp_env(bp_dir):
    return {**clean_env(), "BP_ENV_FILE": os.path.join(bp_dir, "none.env")}


def run(*argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, **kw)


def tdocker(*args):
    r = run("docker", "exec", "sdtest-target", "docker", *args)
    return r.returncode, (r.stdout + r.stderr).strip()


def svc_image(svc):
    return tdocker("service", "inspect", "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}", svc)[1].split("@")[0]


def http_get(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode()
    except Exception as e:
        return f"ERR {e}"


def wait_http(url, want, timeout=60):
    end, got = time.time() + timeout, None
    while time.time() < end:
        got = http_get(url)
        if got == want:
            return got
        time.sleep(1)
    return got


def ssh_target():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(TG["host"], TG["port"], username=TG["user"], key_filename=TG["key_path"], timeout=15,
              allow_agent=False, look_for_keys=False)
    return c


def ssh_run(c, cmd):
    _i, o, e = c.exec_command(cmd)
    code = o.channel.recv_exit_status()
    return code, (o.read() + e.read()).decode().strip()


class App:
    def __init__(self, name, py, cwd, env, probe, gitlab_login=False):
        self.port = free_port()
        self.logp = os.path.join(L, f"chain_{name}.log")
        self.logf = open(self.logp, "w")
        self.proc = subprocess.Popen([py, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(self.port)],
                                     cwd=cwd, env=env, stdout=self.logf, stderr=subprocess.STDOUT)
        for _ in range(150):
            try:
                if self.j("GET", probe)[0] == 200:
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError(f"{name} did not start, see {self.logp}")
        if gitlab_login:  # the deployer's /api/* is gated (401) until a GitLab sign-in
            st, r = self.j("POST", "/api/auth/gitlab/token", {"token": ENV["gitlab"]["pat"], "url": ENV["gitlab"]["url"]})
            if st != 200:
                raise RuntimeError(f"gitlab sign-in failed for {name}: {st} {r}")

    def j(self, method, path, body=None, timeout=60):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        data = json.dumps(body).encode() if body is not None else None
        c.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            return r.status, json.loads(raw)
        except ValueError:
            return r.status, raw.decode("utf-8", "replace")

    def sse(self, path, timeout=400):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        c.request("GET", path)
        r = c.getresponse()
        events, ev, data = [], None, []
        while True:
            line = r.fp.readline()
            if not line:
                break
            line = line.decode("utf-8", "replace").rstrip("\n")
            if line == "":
                if ev:
                    events.append((ev, "\n".join(data)))
                ev, data = None, []
            elif line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                data.append(line[6:])
        c.close()
        return events

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def rpath(job):
    """Build Packager reports remote_path as a URL (sftp://host:port/dir/file.zip); the deployer wants the path."""
    u = job["artifacts"].get("remote_path") or ""
    return "/" + u.split("://", 1)[1].split("/", 1)[1] if "://" in u else u


def wait_done(app, path, timeout=400):
    end = time.time() + timeout
    while time.time() < end:
        st, job = app.j("GET", path)
        if st == 200 and job["status"] in ("success", "failed"):
            return job
        time.sleep(0.5)
    raise TimeoutError(path)


# ---------------------------------------------------------------- A: Build Packager

def phase_a(bp):
    st, r = bp.j("PUT", "/api/config/upload", {"enabled": True, "protocol": "sftp", "host": FS["host"], "port": FS["port"],
                                               "username": FS["user"], "password": FS["password"],
                                               "remote_dir": CHAIN_DIR})
    check("A upload config saved", st == 200, r)
    builds = {}
    for svc, repo, branch in [("sdtest-web1", "mock-web1", "v2"), ("sdtest-web2", "mock-web2", "v2"),
                              ("sdtest-web1", "mock-web1", "broken")]:
        if (svc, branch) == ("sdtest-web1", "broken"):
            time.sleep(1.1)  # unique second per service
        st, job = bp.j("POST", "/api/jobs", {"service": svc, "repo_url": ENV["repos"][repo], "branch": branch,
                                             "password": ZIP_PW, "password_confirm": ZIP_PW, "upload": True})
        if not check(f"A build {svc}@{branch} accepted", st == 201, job):
            continue
        HOST_IMAGES.add(job["image_tag"])
        builds[(svc, branch)] = job
    for key, job in builds.items():
        done = wait_done(bp, f"/api/jobs/{job['id']}", 600)
        builds[key] = done
        rp = rpath(done)
        check(f"A build {key[0]}@{key[1]} success", done["status"] == "success",
              (done.get("error"), [(s["name"], s["status"], s["message"]) for s in done["steps"]]))
        local = os.path.join(ENV["file_server"]["local_root"], (rp or "x").removeprefix("/releases/"))
        check(f"A zip {rp} on file server", rp and rp.startswith(CHAIN_DIR + "/") and os.path.isfile(local), rp)
    return builds


# ---------------------------------------------------------------- B: Swarm Deployer

def configure_b(sd):
    st, r = sd.j("PUT", "/api/config/file-server", {"protocol": "sftp", "host": FS["host"], "port": FS["port"],
                                                    "username": FS["user"], "password": FS["password"],
                                                    "remote_dir": CHAIN_DIR})
    check("B file server saved", st == 200, r)
    st, r = sd.j("POST", "/api/config/file-server/test", {})
    check("B file server test ok", st == 200 and r.get("ok"), r)
    st, r = sd.j("POST", "/api/targets", {
        "id": "lab", "name": "sdtest lab", "host": TG["host"], "port": TG["port"], "username": TG["user"],
        "private_key_path": TG["key_path"], "host_key_policy": "auto_add", "work_dir": TG["work_dir"],
        "backup_dir": TG["backup_dir"],
        "extra_nodes": [{"host": N2["host"], "port": N2["port"], "username": N2["user"],
                         "private_key_path": N2["key_path"]}]})
    check("B target added", st == 201, r)
    st, r = sd.j("POST", "/api/targets/lab/test", {})
    check("B target test: swarm manager", st == 200 and r.get("ok") and r.get("swarm_manager"), r)
    for pkg, n in (("sdtest-web1", 1), ("sdtest-web2", 2)):
        st, r = sd.j("PUT", f"/api/mappings/{pkg}", {"target": "lab", "swarm_service": f"sdtest_web{n}",
                                                     "image_repo": f"sdtest/web{n}", "moving_tag": "latest",
                                                     "health_url": f"http://127.0.0.1:808{n}/health"})
        check(f"B mapping {pkg} -> sdtest_web{n}", st == 200, r)
    st, r = sd.j("PUT", "/api/config/options", {"converge_timeout": 90, "update_monitor": 5, "health_timeout": 20,
                                                "keep_backups": 5})
    check("B options saved", st == 200, r)


def deploy(sd, path, pw=ZIP_PW):
    st, job = sd.j("POST", "/api/deploys", {"package_path": path, "password": pw})
    if st != 201:
        return st, job, []
    events = sd.sse(f"/api/deploys/{job['id']}/logs/stream")
    return st, sd.j("GET", f"/api/deploys/{job['id']}")[1], events


def phases(job):
    return {p["name"]: p["status"] for p in job["phases"]}


def phase_b(sd, builds):
    st, r = sd.j("GET", "/api/packages")
    groups = {g["service"]: g for g in (r.get("groups") or [])} if st == 200 else {}
    want = {k: os.path.basename(rpath(v)) for k, v in builds.items()}
    check("B packages lists both services",
          "sdtest-web1" in groups and "sdtest-web2" in groups and groups["sdtest-web1"]["mapped"], r)
    names1 = [p["name"] for p in groups.get("sdtest-web1", {}).get("packages", [])]
    check("B web1 packages newest first", names1[:2] == [want[("sdtest-web1", "broken")], want[("sdtest-web1", "v2")]],
          names1)

    prev = {n: svc_image(f"sdtest_web{n}") for n in (1, 2)}
    out = {}

    url1 = builds[("sdtest-web1", "v2")]["artifacts"]["remote_path"]
    st, r = sd.j("POST", "/api/deploys", {"package_path": url1.replace("://127.0.0.1:", "://10.9.9.9:"), "password": ZIP_PW})
    check("B URL for another file server refused", st == 400 and "file server" in str(r), (st, r))

    def go(n):  # web1 uses Build Packager's reported URL as-is (SPEC: matching file-server URL accepted)
        out[n] = deploy(sd, url1 if n == 1 else rpath(builds[(f"sdtest-web{n}", "v2")]))
    ts = [threading.Thread(target=go, args=(n,)) for n in (1, 2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    c = ssh_target()
    for n in (1, 2):
        st, job, events = out[n]
        if not check(f"B deploy web{n} accepted", st == 201, job):
            continue
        ph = phases(job)
        check(f"B deploy web{n}: all 10 phases success", list(ph) == ["fetch", "extract", "connect", "transfer",
              "backup", "load", "tag", "deploy", "verify", "cleanup"] and set(ph.values()) == {"success"},
              (job.get("error"), ph))
        kinds = {e for e, _ in events}
        check(f"B deploy web{n}: SSE log+status+end", {"log", "status", "end"} <= kinds, kinds)
        ver = job["version"]
        check(f"B web{n} serves v2 from host", wait_http(f"http://127.0.0.1:1808{n}/version", f"web{n} v2", 30)
              == f"web{n} v2", http_get(f"http://127.0.0.1:1808{n}/version"))
        check(f"B web{n} swarm service image = sdtest/web{n}:{ver}", svc_image(f"sdtest_web{n}") == f"sdtest/web{n}:{ver}",
              svc_image(f"sdtest_web{n}"))
        bk = job.get("backup") or {}
        code, o = ssh_run(c, f"test -s {bk.get('dir')}/service.json && test -s {bk.get('dir')}/meta.json")
        check(f"B web{n} backup dir has service.json", code == 0 and bk.get("dir", "").startswith(TG["backup_dir"]), (bk, o))
        code, o = ssh_run(c, f"cat {bk.get('dir')}/service.json")
        check(f"B web{n} service.json is the old spec ({prev[n]})", prev[n] in o, o[:200])
        _, iid_prev = tdocker("image", "inspect", "--format", "{{.Id}}", prev[n])
        _, iid_bt = tdocker("image", "inspect", "--format", "{{.Id}}", bk.get("tag") or "none")
        check(f"B web{n} backup tag {bk.get('tag')} = v1 image", bk.get("tag") == f"sdtest/web{n}:backup-{job['ts']}"
              and iid_bt == iid_prev and iid_prev.startswith("sha256:"), (bk, iid_bt, iid_prev))
        _, i_new = tdocker("image", "inspect", "--format", "{{.Id}}", f"sdtest/web{n}:{ver}")
        _, i_lat = tdocker("image", "inspect", "--format", "{{.Id}}", f"sdtest/web{n}:latest")
        _, i_ld = tdocker("image", "inspect", "--format", "{{.Id}}", job["loaded_image"])
        check(f"B web{n} tags <repo>:{ver} and :latest -> loaded {job['loaded_image']}",
              i_new == i_lat == i_ld and i_new.startswith("sha256:"), (i_new, i_lat, i_ld))
        r2 = run("docker", "exec", "sdtest-node2", "docker", "image", "inspect", "--format", "{{.Id}}",
                 f"sdtest/web{n}:{ver}")
        check(f"B web{n} image also loaded+tagged on node2", r2.returncode == 0 and r2.stdout.strip() == i_new,
              r2.stdout + r2.stderr)
        code, o = ssh_run(c, f"ls -A {TG['work_dir']}")
        rt = job["artifacts"]["remote_tar"]
        check(f"B web{n} remote tar cleaned up", rt and os.path.basename(rt) not in o, (rt, o))
        jd = job["artifacts"].get("job_dir")
        check(f"B web{n} job dir {jd} removed on target", jd and jd.startswith(TG["work_dir"] + f"/sdtest-web{n}/")
              and ssh_run(c, f"test -e {jd}")[0] != 0, jd)
        check(f"B web{n} local work dir removed", not os.path.exists(os.path.join(L, "chain-sd", "work", job["id"])))
        st, log = sd.j("GET", f"/api/deploys/{job['id']}/log")
        check(f"B web{n} zip password never logged", ZIP_PW not in log and "==> [verify] success" in log, log[-300:])
        check(f"B web{n} service spec JSON not logged", "ContainerSpec" not in log, "ContainerSpec in log")
    c.close()
    st, rows = sd.j("GET", "/api/services")
    by = {r["package"]: r for r in rows} if st == 200 else {}
    check("B dashboard shows current image + last deploy success",
          all((by.get(f"sdtest-web{n}") or {}).get("last_deploy", {}).get("status") == "success"
              and str((by.get(f"sdtest-web{n}") or {}).get("current_image")).startswith(f"sdtest/web{n}:2") for n in (1, 2)),
          rows)
    return out


def phase_c(sd, builds):
    v2path = rpath(builds[("sdtest-web1", "v2")])
    img_before = svc_image("sdtest_web1")
    c = ssh_target()
    bk_before = ssh_run(c, f"ls -R {TG['backup_dir']}")[1]
    st, job, _ = deploy(sd, v2path, pw="wrong-zip-password")
    ph = phases(job) if st == 201 else {}
    check("C wrong zip password -> extract failed, later phases skipped",
          ph.get("fetch") == "success" and ph.get("extract") == "failed"
          and all(ph[p] == "skipped" for p in ("connect", "transfer", "backup", "load", "tag", "deploy", "verify")),
          (st, job.get("error") if isinstance(job, dict) else job, ph))
    check("C wrong password message", "wrong zip password" in str(job.get("error")), job.get("error"))
    check("C wrong password: target unchanged", svc_image("sdtest_web1") == img_before
          and ssh_run(c, f"ls -R {TG['backup_dir']}")[1] == bk_before, (svc_image("sdtest_web1"), img_before))
    c.close()

    # broken branch -> verify fails -> auto rollback to previous (v2)
    st, job, _ = deploy(sd, rpath(builds[("sdtest-web1", "broken")]))
    ph = phases(job) if st == 201 else {}
    check("C broken: deploy ok, verify failed, cleanup ran",
          ph.get("deploy") == "success" and ph.get("verify") == "failed" and ph.get("cleanup") == "success",
          (job.get("error"), ph))
    check("C broken: job failed with 'rolled back to <old image>'",
          job.get("status") == "failed" and f"rolled back to {img_before}" in str(job.get("error"))
          and (job.get("rollback") or {}).get("ok"), (job.get("error"), job.get("rollback")))
    check("C broken: service image back to previous", svc_image("sdtest_web1") == img_before, svc_image("sdtest_web1"))
    check("C broken: still serves v2", wait_http("http://127.0.0.1:18081/version", "web1 v2", 30) == "web1 v2",
          http_get("http://127.0.0.1:18081/version"))
    _, i_lat = tdocker("image", "inspect", "--format", "{{.Id}}", "sdtest/web1:latest")
    _, i_prev = tdocker("image", "inspect", "--format", "{{.Id}}", img_before)
    check("C broken: moving tag :latest restored to previous", i_lat == i_prev, (i_lat, i_prev))


def phase_d(sd):
    st, bks = sd.j("GET", "/api/services/sdtest-web1/backups")
    v1 = [b for b in bks if b.get("previous_image") == "sdtest/web1:v1"] if st == 200 else []
    if not check("D backups list has the v1 backup", v1 and v1[0]["tag_present"], bks):
        return
    st, job = sd.j("POST", "/api/rollbacks", {"package": "sdtest-web1", "backup_id": v1[0]["id"]})
    if not check("D rollback accepted", st == 201, job):
        return
    sd.sse(f"/api/deploys/{job['id']}/logs/stream")
    job = sd.j("GET", f"/api/deploys/{job['id']}")[1]
    check("D rollback job success", job["status"] == "success", (job.get("error"), phases(job)))
    check("D service serves v1", wait_http("http://127.0.0.1:18081/version", "web1 v1", 30) == "web1 v1",
          http_get("http://127.0.0.1:18081/version"))
    # SPEC §5: a manual rollback runs the real version tag (previous_image), not backup-<ts>
    check("D service image = previous version tag", svc_image("sdtest_web1") == "sdtest/web1:v1", svc_image("sdtest_web1"))
    check("D rollback job new_image = v1", job.get("new_image") == "sdtest/web1:v1", job.get("new_image"))


def phase_e(sd, builds):
    st, r = sd.j("PUT", "/api/targets/lab", {"password": "wrong-ssh-pass", "private_key_path": ""})
    check("E target switched to wrong password", st == 200, r)
    img_before = svc_image("sdtest_web2")
    st, job, _ = deploy(sd, rpath(builds[("sdtest-web2", "v2")]))
    ph = phases(job) if st == 201 else {}
    check("E wrong SSH password -> connect failed",
          ph.get("extract") == "success" and ph.get("connect") == "failed" and ph.get("transfer") == "skipped",
          (job.get("error") if isinstance(job, dict) else job, ph))
    check("E connect error mentions authentication", "auth" in str(job.get("error")).lower(), job.get("error"))
    check("E ssh password not in job/log", "wrong-ssh-pass" not in json.dumps(job)
          and "wrong-ssh-pass" not in str(sd.j("GET", f"/api/deploys/{job.get('id')}/log")[1]))
    check("E target unchanged", svc_image("sdtest_web2") == img_before)
    st, r = sd.j("PUT", "/api/targets/lab", {"password": "", "private_key_path": TG["key_path"]})
    check("E target restored to key", st == 200, r)

    n_before = len(sd.j("GET", "/api/deploys")[1])
    st, r = sd.j("POST", "/api/deploys", {"package_path": json.load(open(ENV["packages_json"]))["nomap"],
                                          "password": ZIP_PW})
    check("E unknown mapping refused (4xx) before any job", 400 <= st < 500 and "mapping" in str(r)
          and len(sd.j("GET", "/api/deploys")[1]) == n_before, (st, r))


def phase_f(sd, builds):
    path = rpath(builds[("sdtest-web1", "v2")])
    res, barrier = [], threading.Barrier(2)

    def go():
        barrier.wait()
        res.append(sd.j("POST", "/api/deploys", {"package_path": path, "password": ZIP_PW}))
    ts = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    codes = sorted(st for st, _ in res)
    check("F concurrent deploys same service -> 201 + 409", codes == [201, 409], res)
    ok = [j for st, j in res if st == 201]
    if ok:
        job = wait_done(sd, f"/api/deploys/{ok[0]['id']}")
        check("F the accepted deploy finishes success", job["status"] == "success", (job.get("error"), phases(job)))
        check("F web1 back on v2", wait_http("http://127.0.0.1:18081/version", "web1 v2", 30) == "web1 v2")
        st, r = sd.j("POST", "/api/deploys", {"package_path": path, "password": ZIP_PW})
        check("F after finish a new deploy is accepted again", st == 201, r)
        if st == 201:
            wait_done(sd, f"/api/deploys/{r['id']}")


def phase_g(sd, builds):
    """Review regressions: foreign RepoTags, partial transfer cleanup, rollback when previous image name was re-tagged."""
    import io, tarfile
    import pyzipper
    # G1: an archive whose manifest carries an extra tag (would clobber sdtest/web2:latest on docker load)
    ts, top = "20200101_000000", "sdtest-web1_20200101_000000"
    mbytes = json.dumps([{"Config": "c.json", "RepoTags": [f"sdtest-web1:{ts}", "sdtest/web2:latest"], "Layers": []}]).encode()
    tb = io.BytesIO()
    with tarfile.open(fileobj=tb, mode="w") as t:
        ti = tarfile.TarInfo("manifest.json")
        ti.size = len(mbytes)
        t.addfile(ti, io.BytesIO(mbytes))
    local = os.path.join(ENV["file_server"]["local_root"], "chain", top + ".zip")
    with pyzipper.AESZipFile(local, "w", encryption=pyzipper.WZ_AES) as z:
        z.setpassword(ZIP_PW.encode())
        z.writestr(f"{top}/{top}.tar", tb.getvalue())
    os.chmod(local, 0o644)
    _, lat2 = tdocker("image", "inspect", "--format", "{{.Id}}", "sdtest/web2:latest")
    st, job, _ = deploy(sd, f"{CHAIN_DIR}/{top}.zip")
    ph = phases(job) if st == 201 else {}
    check("G1 archive with foreign RepoTags -> extract failed, nothing loaded",
          ph.get("extract") == "failed" and ph.get("load") == "skipped" and "exactly one image" in str(job.get("error"))
          and tdocker("image", "inspect", "--format", "{{.Id}}", "sdtest/web2:latest")[1] == lat2,
          (job.get("error"), ph))
    os.remove(local)

    # G2: upload fails (root-owned read-only file at the remote tar path) -> cleanup still removes the whole job dir
    b2 = builds[("sdtest-web2", "v2")]
    pkg_ts = os.path.basename(rpath(b2))[len("sdtest-web2_"):-4]  # job dir is W/<package>/<version> (SD AD-3)
    jd = f"{TG['work_dir']}/sdtest-web2/{pkg_ts}"
    rt = f"{jd}/sdtest-web2_v2_{pkg_ts}.tar"  # <svc>_<branch>_<ts>.tar
    r = run("docker", "exec", "-u", "root", "sdtest-target", "sh", "-c",
            f"mkdir -p {jd} && chown deploy:deploy {jd} && touch {rt} && chmod 444 {rt}")
    st, job, _ = deploy(sd, rpath(b2))
    ph = phases(job) if st == 201 else {}
    gone = run("docker", "exec", "sdtest-target", "test", "-e", jd).returncode != 0
    check("G2 failed transfer: transfer failed, cleanup removed the job dir",
          r.returncode == 0 and ph.get("transfer") == "failed" and ph.get("cleanup") == "success" and gone,
          (r.stderr, job.get("error"), ph, gone))

    # G3: service runs <repo>:latest (the moving tag). A failed deploy re-points :latest, so rollback must not
    # trust the name: it must end on the old image.
    _, v2id = tdocker("image", "inspect", "--format", "{{.Id}}", svc_image("sdtest_web1"))
    tdocker("tag", v2id, "sdtest/web1:latest")
    code, o = tdocker("service", "update", "--image", "sdtest/web1:latest", "--no-resolve-image", "--detach=false",
                      "-q", "sdtest_web1")
    check("G3 setup: web1 runs sdtest/web1:latest", code == 0 and svc_image("sdtest_web1") == "sdtest/web1:latest"
          and wait_http("http://127.0.0.1:18081/version", "web1 v2", 30) == "web1 v2", o)
    st, job, _ = deploy(sd, rpath(builds[("sdtest-web1", "broken")]))
    rb = job.get("rollback") or {} if st == 201 else {}
    check("G3 rollback reported ok", job.get("status") == "failed" and rb.get("ok"), (job.get("error"), rb))
    check("G3 web1 serves v2 after rollback", wait_http("http://127.0.0.1:18081/version", "web1 v2", 30) == "web1 v2",
          http_get("http://127.0.0.1:18081/version"))
    _, cur = tdocker("image", "inspect", "--format", "{{.Id}}", svc_image("sdtest_web1"))
    _, lat = tdocker("image", "inspect", "--format", "{{.Id}}", "sdtest/web1:latest")
    check("G3 running image and :latest = old image", cur == lat == v2id, (svc_image("sdtest_web1"), cur, lat, v2id))


def phase_h(sd, sd_data, builds):
    """AC-26: the server is killed (SIGKILL) during verify; on restart the job is rolled back and cleaned up."""
    path = json.load(open(ENV["packages_json"]))["web1_v1b"]  # seeded v1 package; web1 runs v2 now
    _, prev_id = tdocker("image", "inspect", "--format", "{{.Id}}", svc_image("sdtest_web1"))
    st, job = sd.j("POST", "/api/deploys", {"package_path": path, "password": ZIP_PW})
    if not check("H deploy accepted", st == 201, job):
        return sd
    end, ph = time.time() + 300, {}
    while time.time() < end and ph.get("verify") not in ("running", "success", "failed"):
        ph = phases(sd.j("GET", f"/api/deploys/{job['id']}")[1])
        time.sleep(0.2)
    sd.proc.kill()
    sd.proc.wait()
    check("H server killed during verify", ph.get("verify") == "running", ph)
    sd = App("sd2", os.path.join(ROOT, ".venv/bin/python"), ROOT, sd_env(sd_data), "/api/auth/status", gitlab_login=True)
    st, r = sd.j("POST", "/api/deploys", {"package_path": path, "password": ZIP_PW})
    check("H service stays locked during recovery (409)", st == 409, (st, r))
    if st == 201:
        wait_done(sd, f"/api/deploys/{r['id']}")
    done = wait_done(sd, f"/api/deploys/{job['id']}")
    check("H job failed 'interrupted (server restart); rolled back to <img>'", done["status"] == "failed"
          and str(done.get("error")).startswith("interrupted (server restart); rolled back to ")
          and (done.get("rollback") or {}).get("ok"), (done.get("error"), done.get("rollback")))
    check("H cleanup phase ran", phases(done).get("cleanup") == "success", phases(done))
    check("H web1 serves the previous version (v2)",
          wait_http("http://127.0.0.1:18081/version", "web1 v2", 30) == "web1 v2", http_get("http://127.0.0.1:18081/version"))
    _, cur = tdocker("image", "inspect", "--format", "{{.Id}}", svc_image("sdtest_web1"))
    _, lat = tdocker("image", "inspect", "--format", "{{.Id}}", "sdtest/web1:latest")
    check("H running image and :latest = previous image", cur == lat == prev_id, (svc_image("sdtest_web1"), cur, lat))
    rt = done["artifacts"]["remote_tar"]
    left = [c for c in ("sdtest-target", "sdtest-node2") if run("docker", "exec", c, "test", "-e", rt).returncode == 0]
    check("H remote tar removed on target and node2", rt and not left, (rt, left))
    check("H local work dir removed", not os.path.exists(os.path.join(sd_data, "work", job["id"])))
    log = sd.j("GET", f"/api/deploys/{job['id']}/log")[1]
    check("H recovery logged in the job log", "==> [recovery]" in log and "==> [rollback]" in log, log[-500:])
    st, r = sd.j("POST", "/api/deploys", {"package_path": rpath(builds[("sdtest-web1", "v2")]), "password": ZIP_PW})
    check("H after recovery the service accepts deploys again", st == 201, (st, r))
    if st == 201:
        check("H follow-up deploy success", wait_done(sd, f"/api/deploys/{r['id']}")["status"] == "success")
    return sd


def safety_grep():
    src = open(__file__).read()
    import re
    bad = [m.group(0) for m in re.finditer(r"(?<!exec sdtest-target )docker (service|swarm|stack)\b", src)]
    check("safety: no host-daemon swarm commands in this file", not bad, bad)


def main():
    _lock = lab_lock()  # noqa: F841
    safety_grep()
    snap = os.path.join(ROOT, "testenv/host_snapshot.sh")
    before = run("bash", snap, os.path.join(L, "chain_snap_before.txt"))
    r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
    check("lab reset to v1", r.returncode == 0, r.stdout + r.stderr)
    for n in (1, 2):
        check(f"lab web{n} serves v1", http_get(f"http://127.0.0.1:1808{n}/version") == f"web{n} v1")
    shutil.rmtree(os.path.join(ENV["file_server"]["local_root"], "chain"), ignore_errors=True)

    bp_dir = tempfile.mkdtemp(prefix="chain-bp-", dir=L)
    shutil.copy(os.path.join(BP_ROOT, "app.py"), bp_dir)
    shutil.copytree(os.path.join(BP_ROOT, "backend"), os.path.join(bp_dir, "backend"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(BP_ROOT, "frontend", "dist"), os.path.join(bp_dir, "frontend", "dist"))  # built React UI
    sd_data = os.path.join(L, "chain-sd")
    shutil.rmtree(sd_data, ignore_errors=True)
    bp = sd = None
    try:
        bp = App("bp", BP_PY, bp_dir, bp_env(bp_dir), "/api/auth/status")
        print("== A: Build Packager on", bp.port, flush=True)
        builds = phase_a(bp)
        if len(builds) != 3 or any(b["status"] != "success" for b in builds.values()):
            print("A failed, stopping", flush=True)
            return
        sd = App("sd", os.path.join(ROOT, ".venv/bin/python"), ROOT, sd_env(sd_data), "/api/auth/status",
                 gitlab_login=True)
        print("== B: Swarm Deployer on", sd.port, flush=True)
        configure_b(sd)
        phase_b(sd, builds)
        print("== C: failures", flush=True)
        phase_c(sd, builds)
        print("== D: manual rollback", flush=True)
        phase_d(sd)
        print("== E: ssh / mapping errors", flush=True)
        phase_e(sd, builds)
        print("== F: concurrency", flush=True)
        phase_f(sd, builds)
        print("== G: review regressions", flush=True)
        phase_g(sd, builds)
        print("== H: restart mid-deploy (AC-26)", flush=True)
        sd = phase_h(sd, sd_data, builds)
        st, hist = sd.j("GET", "/api/deploys?package=sdtest-web1")
        check("history per service lists web1 jobs only", st == 200 and hist and
              all(j["package"] == "sdtest-web1" for j in hist), hist)
        leaked = [p for p, _d, fs in os.walk(sd_data) for f in fs
                  if ZIP_PW.encode() in open(os.path.join(p, f), "rb").read()]
        check("zip password not stored anywhere in SD_DATA", not leaked, leaked)
    finally:
        for a in (bp, sd):
            if a:
                a.stop()
        for img in HOST_IMAGES:  # only the sdtest-web*:<ts> images Build Packager built
            if img.startswith("sdtest-"):
                run("docker", "rmi", img)
        shutil.rmtree(bp_dir, ignore_errors=True)
        after = run("bash", snap, os.path.join(L, "chain_snap_after.txt"))
        if before.returncode == 0 and after.returncode == 0:
            a, b = (open(os.path.join(L, f)).read() for f in ("chain_snap_before.txt", "chain_snap_after.txt"))
            check("safety: host containers unchanged", a == b, "diff chain_snap_before/after")
        passed = sum(ok for _, ok in RESULTS)
        print(f"\n{passed}/{len(RESULTS)} passed", flush=True)
        sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
