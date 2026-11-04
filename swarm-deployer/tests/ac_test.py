"""API acceptance test for SPEC §9 AC-2..AC-25 (plus FTPS) against the mock lab.
Run: /home/shahzod/mywork/swarm-deployer/.venv/bin/python tests/ac_test.py
Needs the lab up and seeded (testenv/up.sh --node2 && testenv/seed.sh). Takes the lab lock, resets the services to
v1, starts the app on a free port with a fresh temp SD_DATA. Swarm commands only inside sdtest-* containers.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from full_chain_test import (App, ENV, L, RESULTS, ROOT, ZIP_PW, check, lab_lock, phases,  # noqa: E402
                             run, sd_env, svc_image, tdocker, wait_done, wait_http)

P = json.load(open(ENV["packages_json"]))
T, N2 = ENV["target"], ENV["node2"]
SFTP, FTP, FTPS = (ENV["file_server"][k] for k in ("sftp", "ftp", "ftps"))
WEB1, WEB2 = ENV["services"]["sdtest-web1"]["host_url"], ENV["services"]["sdtest-web2"]["host_url"]
SPARE = ENV["spare_port"]
QDIR = "/home/deploy/sd work $X"  # AC-5: space and $ in remote dirs
SECRETS = (ZIP_PW, T["password"], SFTP["password"], ENV["gitlab"]["pat"])
RESP = []  # every API response body, for AC-25
sd = None


def j(method, path, body=None, timeout=120):
    st, r = sd.j(method, path, body, timeout)
    RESP.append(json.dumps(r) if not isinstance(r, str) else r)
    return st, r


def deploy(path, pw=ZIP_PW, **kw):
    st, job = j("POST", "/api/deploys", {"package_path": path, "password": pw, **kw})
    return (st, wait_done(sd, f"/api/deploys/{job['id']}")) if st == 201 else (st, job)


def tsh(cmd, c="sdtest-target"):
    r = subprocess.run(["docker", "exec", "-u", "deploy", c, "sh", "-c", cmd], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def iid(ref, c="sdtest-target"):
    r = run("docker", "exec", c, "docker", "image", "inspect", "--format", "{{.Id}}", ref)
    return r.stdout.strip() if r.returncode == 0 else None


def log_of(job):
    return j("GET", f"/api/deploys/{job['id']}/log")[1]


def settings(data):
    st, r = j("PUT", "/api/config/file-server", {"protocol": "sftp", "host": SFTP["host"], "port": SFTP["port"],
                                                 "username": SFTP["user"], "password": SFTP["password"],
                                                 "remote_dir": "/releases"})
    check("file server saved", st == 200, r)
    check("AC-2 config.json mode 600", oct(os.stat(data + "/config.json").st_mode & 0o777) == "0o600")
    st, r = j("POST", "/api/config/file-server/test", {})
    check("AC-6 SFTP test ok", r.get("ok"), r)
    st, r = j("POST", "/api/config/file-server/test", {"port": 1})
    check("AC-6 closed port -> ok false", r.get("ok") is False, r)
    st, r = j("POST", "/api/config/file-server/test", {"protocol": "ftp", "port": FTP["port"]})
    check("AC-6 FTP test ok", r.get("ok"), r)
    tg = {"id": "lab", "name": "Lab", "host": T["host"], "port": T["port"], "username": T["user"],
          "password": T["password"], "host_key_policy": "auto_add", "work_dir": T["work_dir"],
          "backup_dir": T["backup_dir"],
          "extra_nodes": [{"host": N2["host"], "port": N2["port"], "username": N2["user"], "password": N2["password"]}]}
    st, r = j("POST", "/api/targets", tg)
    check("target added (password auth)", st == 201, r)
    st, r = j("POST", "/api/targets/lab/test", {})
    check("AC-6 target test: swarm manager", r.get("ok") and r.get("swarm_manager"), r)
    j("POST", "/api/targets", dict(tg, id="n2", port=N2["port"], extra_nodes=[]))
    st, r = j("POST", "/api/targets/n2/test", {})
    check("AC-6 node2 as target: not a swarm manager", r.get("ok") is False and "not a swarm manager" in r["message"], r)
    j("DELETE", "/api/targets/n2")
    for pkg, svc, repo, url in (("sdtest-web1", "sdtest_web1", "sdtest/web1", "http://127.0.0.1:8081/health"),
                                ("sdtest-web2", "sdtest_web2", "sdtest/web2", "http://127.0.0.1:8082/health")):
        st, r = j("PUT", f"/api/mappings/{pkg}", {"target": "lab", "swarm_service": svc, "image_repo": repo,
                                                  "moving_tag": "latest", "health_url": url})
        check(f"mapping {pkg}", st == 200, r)
    j("PUT", "/api/mappings/sdtest-bad", {"target": "lab", "swarm_service": "sdtest_web1", "image_repo": "sdtest/web1"})
    j("PUT", "/api/mappings/sdtest-nomap", {"target": "lab", "swarm_service": "sdtest_missing",
                                            "image_repo": "sdtest/web1"})
    st, r = j("PUT", "/api/config/options", {"keep_backups": 5, "converge_timeout": 90, "update_monitor": 5,
                                             "health_timeout": 20})
    check("options saved", st == 200, r)
    st, r = j("GET", "/api/config")
    check("AC-2 GET /api/config: has_password, no stored password", r["file_server"]["has_password"]
          and r["targets"][0]["has_password"] and not any(s in json.dumps(r) for s in SECRETS), r)


def validation():
    for m, p, b in [
            ("PUT", "/api/mappings/x1", {"target": "lab", "swarm_service": "x;rm -rf /", "image_repo": "a/b"}),
            ("PUT", "/api/mappings/x1", {"target": "lab", "swarm_service": "ok", "image_repo": "Bad/Repo"}),
            ("PUT", "/api/mappings/x1", {"target": "lab", "swarm_service": "ok", "image_repo": "a/b",
                                         "moving_tag": "backup-1"}),
            ("PUT", "/api/targets/lab", {"work_dir": "rel/dir"}), ("PUT", "/api/targets/lab", {"work_dir": "/a/../b"}),
            ("PUT", "/api/targets/lab", {"docker_cmd": "bash -c"}),
            ("POST", "/api/deploys", {"package_path": "/releases/x.zip", "password": "a"}),
            ("POST", "/api/deploys", {"package_path": P["web1_v2"], "password": ""}),
            ("PUT", "/api/mappings/x1", {"target": "lab", "swarm_service": "ok", "image_repo": "a/b",
                                         "health_url": "file:///etc/passwd"}),
            ("PUT", "/api/mappings/x1", {"target": "lab", "swarm_service": "ok", "image_repo": "a/b",
                                         "create": {"replicas": 1, "publish": ["80"]}}),
            ("PUT", "/api/config/file-server", {"verify_tls": "yes"})]:
        st, r = j(m, p, b)
        check(f"AC-4 400 {m} {p} {json.dumps(b)[:70]}", st == 400, (st, r))
    j("DELETE", "/api/mappings/x1")


def listing():
    st, r = j("GET", "/api/packages")
    gs = {g["service"]: g for g in r.get("groups", [])}
    check("AC-7 dirs has archive/", "archive" in r.get("dirs", []), r.get("dirs"))
    check("AC-7 other has README.txt", "README.txt" in r.get("other", []), r.get("other"))
    names = [p["name"] for p in gs.get("sdtest-web1", {}).get("packages", [])]
    check("AC-7 web1 newest first", len(names) >= 4 and names == sorted(names, reverse=True), names)
    check("AC-7 mapped flags", gs.get("sdtest-web1", {}).get("mapped") is True
          and "sdtest-web2" in gs and gs["sdtest-web2"]["mapped"], list(gs))
    st, rows = j("GET", "/api/services")
    by = {x["package"]: x for x in rows} if isinstance(rows, list) else {}
    for n in (1, 2):
        row = by.get(f"sdtest-web{n}", {})
        check(f"AC-8 web{n} runs sdtest/web{n}:v1 1/1", row.get("current_image") == f"sdtest/web{n}:v1"
              and row.get("replicas_running") == 1 == row.get("replicas_desired"), row)
    check("AC-8 missing service exists false", by.get("sdtest-nomap", {}).get("exists") is False, by.get("sdtest-nomap"))
    return r


def early_failures():
    st, job = deploy(P["web1_v2"], pw="wrong-zip-password")
    ph = phases(job)
    check("AC-11 wrong password: extract failed, connect..verify skipped, cleanup success",
          ph.get("extract") == "failed" and "wrong zip password" in str(job.get("error"))
          and all(ph[p] == "skipped" for p in ("connect", "transfer", "backup", "load", "tag", "deploy", "verify"))
          and ph.get("cleanup") == "success", (job.get("error"), ph))
    code, _ = tsh(f"test -e {T['backup_dir']} || test -e {T['work_dir']}")
    check("AC-11 nothing created on target", code != 0 and svc_image("sdtest_web1") == "sdtest/web1:v1")
    st, job = deploy(P["bad"])
    check("AC-12 not a docker image archive", phases(job).get("extract") == "failed"
          and "not a docker image archive" in str(job.get("error")), (job.get("error"), phases(job)))
    st, job = deploy(P["nomap"])
    check("AC-13 missing service: connect failed 'not found on target'", phases(job).get("connect") == "failed"
          and "not found on target" in str(job.get("error")), (job.get("error"), phases(job)))
    j("PUT", "/api/mappings/sdtest-nomap", {"target": "lab", "swarm_service": "sdtest_missing",
                                            "image_repo": "sdtest/web1", "create_if_missing": True,
                                            "create": {"replicas": 1, "publish": [f"{SPARE['container_port']}:8080"]}})
    st, job = deploy(P["nomap"])
    check("AC-13 create_if_missing: mode create, backup skipped, success", job.get("status") == "success"
          and job.get("mode") == "create" and phases(job).get("backup") == "skipped", (job.get("error"), phases(job)))
    # no placement constraint on a created service: its mode=host port is on whichever node (target or node2) runs it
    node = tdocker("service", "ps", "--filter", "desired-state=running", "--format", "{{.Node}}", "sdtest_missing")[1]
    r = run("docker", "exec", node or "sdtest-target", "wget", "-qO-", f"http://127.0.0.1:{SPARE['container_port']}/version")
    check("AC-13 created service serves web1 v2", node in ("sdtest-target", "sdtest-node2") and r.stdout == "web1 v2",
          (node, r.stdout, r.stderr))


def happy_path(data):
    web2_tasks = tdocker("service", "ps", "-q", "sdtest_web2")[1]
    v1_id = iid("sdtest/web1:v1")
    st, job = deploy(P["web1_v2"])
    ver, ts = job.get("version"), job.get("ts")
    check("AC-9 v2 success, 10 phases success", job.get("status") == "success"
          and len(job["phases"]) == 10 and set(phases(job).values()) == {"success"}, (job.get("error"), phases(job)))
    check("AC-9 /version = web1 v2", wait_http(WEB1 + "/version", "web1 v2", 30) == "web1 v2")
    check("AC-9 :<version> and :latest same id, backup tag = v1 id",
          iid(f"sdtest/web1:{ver}") == iid("sdtest/web1:latest") is not None
          and iid(f"sdtest/web1:backup-{ts}") == v1_id is not None)
    bd = f"{T['backup_dir']}/sdtest_web1/{ts}"  # new layout B/<svc>/<ts> (SD AD-5)
    code, spec = tsh(f"cat {bd}/service.json")
    code2, meta = tsh(f"cat {bd}/meta.json")
    ok = False
    try:
        ok = "sdtest/web1:v1" in json.dumps(json.loads(spec)) and json.loads(meta)["previous_image"] == "sdtest/web1:v1"
    except ValueError:
        pass
    check("AC-9 service.json = old spec, meta previous_image v1", code == code2 == 0 and ok, (spec[:200], meta))
    rt = job["artifacts"]["remote_tar"]
    check("AC-9 remote tar gone, data/work/<id> gone", tsh(f"test -e {rt}")[0] != 0
          and not os.path.exists(os.path.join(data, "work", job["id"])))
    check("AC-10 web2 task ids unchanged", tdocker("service", "ps", "-q", "sdtest_web2")[1] == web2_tasks)
    check("AC-21 node2 has sdtest/web1:<version>, tar removed",
          iid(f"sdtest/web1:{ver}", "sdtest-node2") == iid(f"sdtest/web1:{ver}")
          and tsh(f"test -e {rt}", "sdtest-node2")[0] != 0)
    log = log_of(job)
    check("AC-24 started + result line per phase", all(f"==> [{p}] started" in log and f"==> [{p}] success" in log
                                                         for p in phases(job)))
    check("AC-24 quoted docker commands, docker load output, JOB SUCCESS",
          "$ [127.0.0.1] docker " in log and "Loaded image" in log and "==> JOB SUCCESS" in log, log[-300:])
    check("AC-24 host key saved to known_hosts (auto_add)",
          f"[127.0.0.1]:{T['port']}" in open(os.path.join(data, "known_hosts")).read())
    with urllib.request.urlopen(f"http://127.0.0.1:{sd.port}/api/deploys/{job['id']}/logs/stream", timeout=30) as r:
        body = r.read().decode()
    RESP.append(body)
    check("AC-23 replay: log, status, end", all(f"event: {e}" in body for e in ("log", "status", "end")), body[-200:])
    return job


def manual_rollback(job9):
    st, bks = j("GET", "/api/services/sdtest-web1/backups")
    b = next((x for x in bks if x["id"] == f"sdtest_web1_{job9['ts']}"), None) if st == 200 else None
    if not check("AC-19 backups list has the AC-9 backup", b and b["tag_present"], bks):
        return
    st, rb = j("POST", "/api/rollbacks", {"package": "sdtest-web1", "backup_id": b["id"]})
    rb = wait_done(sd, f"/api/deploys/{rb['id']}") if st == 201 else rb
    check("AC-19 rollback success, phases connect..verify", rb.get("status") == "success"
          and list(phases(rb)) == ["connect", "backup", "load", "deploy", "verify"], (rb.get("error"), phases(rb)))
    check("AC-19 /version = web1 v1", wait_http(WEB1 + "/version", "web1 v1", 30) == "web1 v1")
    st, bks = j("GET", "/api/services/sdtest-web1/backups")
    check("AC-19 new backup of v2 exists", any(x["previous_image"] == job9["new_image"] for x in bks), bks)


def concurrency():
    res, bar = {}, threading.Barrier(3)

    def go(k, path):
        bar.wait()
        res[k] = sd.j("POST", "/api/deploys", {"package_path": path, "password": ZIP_PW})
    ts = [threading.Thread(target=go, args=a) for a in (("a", P["web1_v2"]), ("b", P["web1_v2"]), ("w2", P["web2_v2"]))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    check("AC-20 same service twice -> 201 + 409, web2 in parallel 201",
          sorted([res["a"][0], res["b"][0]]) == [201, 409] and res["w2"][0] == 201, res)
    done = [wait_done(sd, f"/api/deploys/{r['id']}") for st, r in res.values() if st == 201]
    check("AC-20 both accepted deploys succeed", len(done) == 2 and all(d["status"] == "success" for d in done),
          [(d["package"], d.get("error")) for d in done])


def redeploy_and_failures():
    st, job = deploy(P["web1_v2"])
    check("AC-16 redeploy same version: --force, success", job.get("status") == "success" and "--force" in log_of(job),
          job.get("error"))
    for ac, key in (("AC-14", "web1_broken"), ("AC-15", "web1_unhealthy")):
        prev = svc_image("sdtest_web1")
        prev_id = iid(prev)
        st, job = deploy(P[key])
        rb = job.get("rollback") or {}
        check(f"{ac} {key}: verify failed, rolled back to {prev}", phases(job).get("verify") == "failed"
              and rb.get("ok") and rb.get("method") in ("swarm_auto", "service_rollback")
              and str(job.get("error")).endswith(f"rolled back to {prev}"), (job.get("error"), rb))
        check(f"{ac} serves previous version, :latest = previous image",
              wait_http(WEB1 + "/version", "web1 v2", 30) == "web1 v2" and iid("sdtest/web1:latest") == prev_id)


def backups():
    j("PUT", "/api/config/options", {"keep_backups": 2})
    st, job = deploy(P["web1_v1b"], save_image_tar=True)
    check("AC-18 deploy with save_image_tar success", job.get("status") == "success", (job.get("error"), phases(job)))
    st, bks = j("GET", "/api/services/sdtest-web1/backups")
    check("AC-18 image.tar present, has_image_tar", bks and bks[0]["has_image_tar"]
          and tsh(f"test -s {bks[0]['dir']}/image.tar")[0] == 0, bks[:1])
    code, o = tsh(f"ls {T['backup_dir']}/sdtest_web1")
    dirs = {n for n in o.split() if re.fullmatch(r"\d{8}_\d{6}", n)}
    tags = {t.split(":backup-")[1] for t in tdocker("images", "--format", "{{.Repository}}:{{.Tag}}", "sdtest/web1")[1]
            .split() if ":backup-" in t}
    in_use = {svc_image("sdtest_web1").partition(":backup-")[2]} - {""}
    check("AC-17 keep_backups 2: 2 web1 backup dirs, pruned tags removed", len(dirs) == 2 and tags <= dirs | in_use,
          (dirs, tags))
    b0 = bks[0]
    tdocker("rmi", b0["backup_tag"])
    st, rb = j("POST", "/api/rollbacks", {"package": "sdtest-web1", "backup_id": b0["id"]})
    rb = wait_done(sd, f"/api/deploys/{rb['id']}") if st == 201 else rb
    check("AC-19 rollback after rmi of backup tag loads image.tar", rb.get("status") == "success"
          and "loading" in log_of(rb), (rb.get("error"), phases(rb)))
    check("AC-19 tar rollback serves v2", wait_http(WEB1 + "/version", "web1 v2", 30) == "web1 v2")


def ftp_and_ftps(sftp_listing):
    def same(r):
        key = lambda x: ([(g["service"], [p["name"] for p in g["packages"]]) for g in x.get("groups", [])],  # noqa
                         x.get("dirs"), x.get("other"))
        return key(r) == key(sftp_listing)
    for proto, srv, ver in (("ftp", FTP, "v1b"), ("ftps", FTPS, "v2")):
        name = proto.upper()
        st, r = j("PUT", "/api/config/file-server", {"protocol": proto, "port": srv["port"], "verify_tls": False})
        check(f"{name} file server saved", st == 200 and r.get("verify_tls") is False, r)
        st, r = j("POST", "/api/config/file-server/test", {})
        check(f"{name} test ok", r.get("ok"), r)
        st, r = j("GET", "/api/packages")
        check(f"AC-7 {name} listing identical to SFTP", st == 200 and same(r), r)
        path = P[f"web1_{ver}"]
        if proto == "ftps":  # Build Packager-style URL for our own server
            path = f"ftps://127.0.0.1:{srv['port']}{path}"
        st, job = deploy(path)
        check(f"AC-22 deploy via {name} success", job.get("status") == "success", (st, job.get("error"), phases(job)))
        check(f"AC-22 {name}: /version = web1 {ver[:2]}",
              wait_http(WEB1 + "/version", f"web1 {ver[:2]}", 30) == f"web1 {ver[:2]}")
    st, r = j("POST", "/api/config/file-server/test", {"verify_tls": True})
    check("FTPS verify_tls true rejects the self-signed cert", r.get("ok") is False
          and "certificate verify failed" in r.get("message", "").lower(), r)
    j("PUT", "/api/config/file-server", {"protocol": "sftp", "port": SFTP["port"]})


def quoting():
    j("PUT", "/api/targets/lab", {"work_dir": QDIR, "backup_dir": QDIR + "/bk"})
    st, job = deploy(P["web1_v2"])
    check("AC-5 deploy with space + $ in dirs", job.get("status") == "success", (job.get("error"), phases(job)))
    check("AC-5 literal path used on target", tsh(f"ls -d '{QDIR}/bk/sdtest_web1/'2*")[0] == 0)
    j("PUT", "/api/targets/lab", {"work_dir": T["work_dir"], "backup_dir": T["backup_dir"]})


def backend_source():
    """All backend code (backend/**/*.py + app.py), for the static checks."""
    import glob
    files = [os.path.join(ROOT, "app.py")] + sorted(glob.glob(os.path.join(ROOT, "backend", "**", "*.py"), recursive=True))
    return "\n".join(open(f).read() for f in files)


def static_checks():
    src = backend_source()
    check("AC-3 backend: no subprocess / os.system / shell=True",
          not re.search(r"import subprocess|os\.system|shell=True", src))
    calls = re.findall(r"exec_command\(([^)]*)", src)
    check("AC-3 every exec_command gets shell_cmd(...)", calls and all(c.startswith("shell_cmd(") for c in calls), calls)
    check("AC-3b backend has the /api/auth/ routes; exec_command still only with shell_cmd(",
          '"/api/auth/' in src and all(c.startswith("shell_cmd(") for c in calls), calls)


def main():
    global sd
    _lock = lab_lock()  # noqa: F841
    static_checks()
    snap = os.path.join(ROOT, "testenv/host_snapshot.sh")
    run("bash", snap, os.path.join(L, "ac_snap_before.txt"))
    r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
    check("lab reset to v1", r.returncode == 0, r.stdout + r.stderr)
    data = tempfile.mkdtemp(prefix="ac-sd-", dir=L)
    try:
        sd = App("ac", os.path.join(ROOT, ".venv/bin/python"), ROOT, sd_env(data), "/api/auth/status", gitlab_login=True)
        settings(data)
        validation()
        listing_ = listing()
        early_failures()
        job9 = happy_path(data)
        manual_rollback(job9)
        concurrency()
        redeploy_and_failures()
        backups()
        ftp_and_ftps(listing_)
        quoting()
        g = run("grep", "-rl", ZIP_PW, data).stdout.split()
        check("AC-25 zip password nowhere in SD_DATA", not g, g)
        g = run("grep", "-rlF", T["password"], data).stdout.split()
        check("AC-25 stored passwords only in config.json", g == [os.path.join(data, "config.json")], g)
        check("AC-25 no password in any API / SSE response", not any(s in x for x in RESP for s in SECRETS))
    finally:
        if sd:
            sd.stop()
        tdocker("service", "rm", "sdtest_missing")
        for c in ("sdtest-target", "sdtest-node2"):
            run("docker", "exec", c, "rm", "-rf", "--", QDIR)
        r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
        check("lab reset to v1 afterwards", r.returncode == 0, r.stdout + r.stderr)
        shutil.rmtree(data, ignore_errors=True)
        run("bash", snap, os.path.join(L, "ac_snap_after.txt"))
        a, b = (open(os.path.join(L, f)).read() for f in ("ac_snap_before.txt", "ac_snap_after.txt"))
        check("safety: host containers unchanged", a == b)
        passed = sum(ok for _, ok in RESULTS)
        print(f"\n{passed}/{len(RESULTS)} passed", flush=True)
        sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
