"""No-lab checks of review fixes that the lab suites can't reach cheaply (fake Shell, temp data dirs).
Run: /home/shahzod/mywork/swarm-deployer/.venv/bin/python tests/unit_test.py
Starts no server and touches no docker; SD_DATA and a copy of Build Packager live in a temp dir."""
import http.server
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="sd-unit-")
os.environ.update(SD_DATA=os.path.join(TMP, "sd"), SD_ENV_FILE=os.path.join(TMP, "none.env"))
os.umask(0o002)
sys.path.insert(0, ROOT)
from fastapi import HTTPException  # noqa: E402

from backend.config.store import find, update_config  # noqa: E402
from backend.core.paths import DATA, KEYS  # noqa: E402
from backend.envimport.apply import apply_env  # noqa: E402
from backend.envimport.parser import parse_env  # noqa: E402
from backend.gitlab.client import gl_get  # noqa: E402
from backend.jobs.runner import Runner  # noqa: E402
from backend.utils.files import write_json  # noqa: E402
from backend.validators.settings import check_target  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -> {detail}"), flush=True)


class FakeShell:
    """Records argv; image inspect answers from self.ids (ref -> id)."""
    host, port = "t", 22

    def __init__(self, ids):
        self.ids, self.calls, self.D = dict(ids), [], ["docker"]

    def run(self, argv, timeout=None, quiet=False, stdin=None):
        self.calls.append(argv)
        if argv[1:3] == ["image", "inspect"]:
            ref = argv[-1]
            return (0, self.ids[ref]) if ref in self.ids else (1, "No such image")
        if argv[1] == "tag":
            self.ids[argv[3]] = self.ids.get(argv[2], argv[2])
        if argv[1] == "rmi":
            self.ids.pop(argv[2], None)
        if argv[1:3] == ["service", "update"]:
            return 0, ""
        return 0, ""

    check = lambda self, argv, **k: self.run(argv)[1]  # noqa: E731


def runner(job, sh):
    r = object.__new__(Runner)
    r.job, r.sh, r.nodes, r.masks = job, sh, [], ["s3cret-pass"]
    r.opt = {"prune_after": False, "converge_timeout": 1, "health_timeout": 1}
    r.work = os.path.join(TMP, "work-x")
    r.m, r.t, r.prev_id, r.touched, r.swarm_auto = {}, {}, None, False, False
    r.logs = []
    r.log = r.logs.append
    r.save = lambda: None
    return r


def job_base(**kw):
    j = {"id": "x", "kind": "deploy", "error": None, "phases": [{"name": "load", "status": "failed"},
                                                                    {"name": "cleanup", "status": "running"}],
         "artifacts": {"job_dir": None, "remote_tar": None}, "registry": None, "new_image": "oc:20261103_120000",
         "moving_image": "oc:latest", "previous_image": "oc:latest", "previous_ref": None, "previous_digest": None,
         "load_tags": {}, "backup": None, "mode": "update", "swarm_service": "svc", "pushed": [], "health_url": ""}
    j.update(kw)
    return j


# DR1: load failed (no rollback ran): cleanup restores every RepoTag docker load moved, the moving tag included
sh = FakeShell({"oc:latest": "sha256:new"})
r = runner(job_base(load_tags={"t:22": {"oc:latest": "sha256:old"}}), sh)
r.p_cleanup()
check("DR1 failed load: cleanup puts oc:latest (= moving tag) back on the old image", sh.ids.get("oc:latest") == "sha256:old",
      sh.calls)
sh = FakeShell({"oc:latest": "sha256:new"})
r = runner(job_base(load_tags={"t:22": {"oc:latest": "sha256:old"}},
                    phases=[{"name": "load", "status": "success"}, {"name": "cleanup", "status": "running"}]), sh)
r.p_cleanup()
check("DR1 success: cleanup leaves the moving tag on the deployed image", sh.ids.get("oc:latest") == "sha256:new", sh.calls)

# DR9 + prune_after: success prunes; a failed registry deploy drops only its local :<ts> tag and never prunes
sh = FakeShell({"r:5000/oc:20261103_120000": "sha256:new"})
r = runner(job_base(registry="r:5000", new_image="r:5000/oc:20261103_120000", moving_image="r:5000/oc:dev",
                    phases=[{"name": "tag", "status": "success"}, {"name": "cleanup", "status": "running"}]), sh)
r.opt["prune_after"] = True
r.p_cleanup()
check("prune_after: success runs docker system prune -f", ["docker", "system", "prune", "-f"] in sh.calls, sh.calls)
sh = FakeShell({"r:5000/oc:20261103_120000": "sha256:new"})
r = runner(job_base(registry="r:5000", new_image="r:5000/oc:20261103_120000", moving_image="r:5000/oc:dev",
                    phases=[{"name": "tag", "status": "failed"}, {"name": "cleanup", "status": "running"}]), sh)
r.opt["prune_after"] = True
r.p_cleanup()
check("DR9 failed registry deploy: rmi :<ts>, no prune", ["docker", "rmi", "r:5000/oc:20261103_120000"] in sh.calls
      and ["docker", "system", "prune", "-f"] not in sh.calls, sh.calls)

# DR2: non-registry, @current re-pointed repo:v1; restore_tags put it back -> redeploy repo:v1, not backup-<ts>
sh = FakeShell({"oc:v1": "sha256:new", "oc:backup-1": "sha256:old"})
j = job_base(new_image="oc:20261103_120000", moving_image="oc:v1", previous_image="oc:v1",
             backup={"tag": "oc:backup-1"}, phases=[{"name": "verify", "status": "failed"}])
r = runner(j, sh)
r.prev_id, r.touched = "sha256:old", True
r.wait_on = lambda img, st=None: True
r.auto_rollback()
upd = [c for c in sh.calls if c[1:3] == ["service", "update"]]
check("DR2 rollback redeploys oc:v1 (restored), never backup- in the spec",
      upd and upd[-1][upd[-1].index("--image") + 1] == "oc:v1" and j["rollback"]["to_image"] == "oc:v1", upd)

# DR3: registry repair without a digest or old image id must not re-push the bad local tag
sh = FakeShell({"r:5000/oc:dev": "sha256:new"})
j = job_base(registry="r:5000", moving_image="r:5000/oc:dev", previous_image="r:5000/oc:dev",
             previous_ref="r:5000/oc:dev", pushed=["r:5000/oc:dev"])
r = runner(j, sh)
out = r.registry_repair()
check("DR3 no digest + no prev id: no push, reported", "not restored" in out and not [c for c in sh.calls if c[1] == "push"],
      sh.calls)

# AS5: finish-time masking of job error and phase messages
j = job_base(error="internal error: login s3cret-pass failed", phases=[{"name": "load", "status": "failed",
                                                                         "message": "x s3cret-pass"}])
r = runner(j, FakeShell({}))
r.job["error"], ph = r.mask(j["error"]), [dict(p, message=r.mask(p["message"])) for p in j["phases"]]
check("AS5 Runner.mask hides secrets in error/phase text", "s3cret" not in r.job["error"] + ph[0]["message"])

# AS3: write_json creates the tmp file 0600 from the first byte, also over an existing 0644 tmp
p = os.path.join(TMP, "c.json")
open(p + ".tmp", "w").close()
os.chmod(p + ".tmp", 0o644)
seen = []
real = os.replace
os.replace = lambda a, b: (seen.append(stat.S_IMODE(os.stat(a).st_mode)), real(a, b))
try:
    write_json(p, {"token": "t"}, 0o600)
finally:
    os.replace = real
check("AS3 SD write_json tmp mode 600 before rename", seen == [0o600], seen)
check("AS4 SD data dir mode 700", stat.S_IMODE(os.stat(DATA).st_mode) == 0o700)

# non-registry deploy: the service spec names the moving tag (:dev), not :<ts>
sh = FakeShell({})
r = runner(job_base(loaded_image="search:20261104_112052", new_image="reg/search:20261104_112052",
                    moving_image="reg/search:dev"), sh)
r.all_hosts = lambda: [sh]
r.p_tag()
check("non-registry deploys the moving tag", r.job["deploy_image"] == "reg/search:dev", r.job["deploy_image"])
r.job.update(moving_image=None, deploy_image=None)
r.p_tag()
check("no moving tag: deploys :<ts>", r.job["deploy_image"] == "reg/search:20261104_112052", r.job["deploy_image"])

# AS1: gl_get refuses a redirect (the Bearer header must not follow it)
hits = []


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/sink"):
            hits.append(self.headers.get("Authorization"))
            self.send_response(200)
        else:
            self.send_response(302)
            self.send_header("Location", f"http://localhost:{srv.server_port}/sink")
        self.end_headers()

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
update_config(lambda c: c["gitlab"].update(url=f"http://127.0.0.1:{srv.server_port}", token="glpat-x"))
st, _ = gl_get("/api/v4/user")
srv.shutdown()
check("AS1 gl_get: 302 is returned as an error, token not sent on", st == 302 and not hits, (st, hits))

# AS2: check_target drops the saved SSH / registry password when the host / URL changes
old = check_target({"id": "lab", "host": "10.0.0.1", "username": "deploy", "password": "pw1", "work_dir": "/w",
                        "backup_dir": "/b", "registry": {"url": "10.0.0.1:5050", "username": "u", "password": "rp"}})
t = check_target({"id": "lab", "host": "10.0.0.2"}, old)
check("AS2 new host without password: saved SSH password dropped", t["password"] == "")
t = check_target({"id": "lab", "port": 2222}, old)
check("AS2 same host: password kept", t["password"] == "pw1")
try:
    check_target({"id": "lab", "registry": {"url": "10.0.0.9:5050"}}, old)
    check("AS2/DR7 new registry URL without password -> 400", False)
except HTTPException as e:
    check("AS2/DR7 new registry URL without password -> 400", e.status_code == 400 and "registry." in e.detail and "required" in e.detail, e.detail)
t = check_target({"id": "lab", "registry": {"url": "10.0.0.1:5050"}}, old)
check("AS2 same registry URL: credentials kept", t["registry"]["password"] == "rp" and t["registry"]["username"] == "u")

# AS7: KEY = value accepted like Build Packager
check("AS7 parse_env 'KEY = value'", parse_env("FILE_SERVER_PASSWORD = abc\n").get("FILE_SERVER_PASSWORD") == "abc",
      parse_env("FILE_SERVER_PASSWORD = abc\n"))

# AS12: single-line key with literal \n escapes is written with real newlines
key = "-----BEGIN OPENSSH PRIVATE KEY-----\\nAAAA\\n-----END OPENSSH PRIVATE KEY-----\\n"
update_config(lambda c: c["targets"].append(dict(old)) if not find(c["targets"], "id", "lab") else None)
res = apply_env({"SD_TARGET_ID": "lab", "BASE_DEVELOPMENT_SSH_PRIVATE_KEY": key})
kp = os.path.join(KEYS, "lab")
check("AS12 escaped key -> key file with real newlines", "targets.lab.private_key_path" in res["set"] and os.path.isfile(kp)
      and open(kp).read().count("\n") >= 3 and "\\n" not in open(kp).read(), res)

# AS3 / AS4 Build Packager: run a temp copy (its DATA is BASE/data)
bp = os.path.join(TMP, "bp")
os.makedirs(bp)
shutil.copy(os.path.join(os.path.dirname(ROOT), "build-packager", "app.py"), bp)
shutil.copytree(os.path.join(os.path.dirname(ROOT), "build-packager", "backend"), os.path.join(bp, "backend"), ignore=shutil.ignore_patterns("__pycache__"))
code = r'''
import os, stat, sys, json, tempfile
sys.path.insert(0, sys.argv[1]); os.umask(0o002)
from backend.core.paths import DATA
from backend.utils.files import write_json
p = os.path.join(DATA, "c.json"); seen = []; real = os.replace
os.replace = lambda a, b: (seen.append(stat.S_IMODE(os.stat(a).st_mode)), real(a, b))
write_json(p, {}, 0o600); os.replace = real
print(json.dumps({"tmp": seen, "data": stat.S_IMODE(os.stat(DATA).st_mode)}))
'''
bpy = os.path.join(os.path.dirname(ROOT), "build-packager", ".venv", "bin", "python")
out = subprocess.run([bpy, "-c", code, bp], capture_output=True, text=True, cwd=bp)
try:
    o = json.loads(out.stdout.strip().splitlines()[-1])
except (ValueError, IndexError):
    o = {}
check("AS3 BP write_json tmp mode 600 before rename", o.get("tmp") == [0o600], out.stderr[-300:])
check("AS4 BP data dir mode 700", o.get("data") == 0o700, o)

shutil.rmtree(TMP, ignore_errors=True)
passed = sum(ok for _, ok in RESULTS)
print(f"\n{passed}/{len(RESULTS)} passed", flush=True)
sys.exit(0 if passed == len(RESULTS) else 1)
