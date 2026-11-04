"""Browser UI test for Swarm Deployer (SPEC.md §8, AC-27..31). Drives the real UI in headless system Chrome
against the running mock lab (testenv/env.json; testenv/up.sh --node2 && testenv/seed.sh if it is down).

Run:  <pwvenv>/bin/python tests/ui_test.py [shots_dir]
  pwvenv = a venv with `pip install playwright` (uses /usr/bin/google-chrome, no browser download).
The app runs with the project .venv on a free 127.0.0.1 port and a fresh temp SD_DATA, so nothing real is touched.
Its target uses its own work/backup dirs on sdtest-target (/home/deploy/sd-ui-*), so backups listed are ours.
Every swarm command runs over SSH inside sdtest-target; this file never talks to the host daemon's swarm.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def backend_source():
    """All backend code (backend/**/*.py + app.py), for the static checks."""
    import glob
    files = [os.path.join(ROOT, "app.py")] + sorted(glob.glob(os.path.join(ROOT, "backend", "**", "*.py"), recursive=True))
    return "\n".join(open(f).read() for f in files)
PY = os.path.join(ROOT, ".venv", "bin", "python")
ENV = json.load(open(os.path.join(ROOT, "testenv", "env.json")))
PKGS = json.load(open(ENV["packages_json"]))
FS, TG = ENV["file_server"]["sftp"], ENV["target"]
ZIP_PW = ENV["zip_password"]
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ENV["scratch_dir"], "shots", "r1")
RESULTS, CONSOLE = [], []
expect.set_options(timeout=15000)


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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}/"


def check(name, cond, evidence=""):
    RESULTS.append((name, bool(cond), evidence))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {evidence}"), flush=True)
    return bool(cond)


def soft(name, fn):
    try:
        fn()
        return check(name, True)
    except Exception as e:  # noqa: BLE001
        return check(name, False, str(e).splitlines()[0][:300])


def tdocker(*args):  # swarm commands only inside the mock target
    return subprocess.run(["docker", "exec", "sdtest-target", "docker", *args], capture_output=True, text=True).stdout.strip()


def web1_version():
    try:
        return urllib.request.urlopen("http://127.0.0.1:18081/version", timeout=3).read().decode().strip()
    except OSError as e:
        return f"error {e}"


def server_env(data):
    """No GitLab env from the shell, and an SD_ENV_FILE that doesn't exist (nothing imported)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GITLAB_") and k not in ("SD_ENV_FILE", "BP_ENV_FILE")}
    return {**env, "SD_DATA": data, "SD_ENV_FILE": os.path.join(data, "none.env")}


def start_server(data):
    logf = open(os.path.join(data, "server.log"), "w")
    proc = subprocess.Popen([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
                            cwd=ROOT, env=server_env(data), stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(BASE + "api/auth/status", timeout=2)  # /api/* is gated until GitLab sign-in
            return proc
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("server did not start")


def new_page(browser, name, **ctx):
    c = browser.new_context(viewport=ctx.pop("viewport", {"width": 1280, "height": 800}), **ctx)
    c.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    p = c.new_page()
    p.on("console", lambda m: m.type == "error" and CONSOLE.append(f"[{name}] console: {m.text} @ {m.location.get('url', '')}"))
    p.on("pageerror", lambda e: CONSOLE.append(f"[{name}] pageerror: {e}"))
    return p


def shot(page, name):
    page.wait_for_timeout(250)
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


def no_hscroll(page, label):
    w = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    check(f"375px no horizontal scroll: {label}", w[0] <= w[1], w)


def wait_hash(page, pattern, timeout=15000):
    page.wait_for_function("re => new RegExp(re).test(location.hash)", arg=pattern, timeout=timeout)
    page.wait_for_timeout(100)


def next_btn(page):
    return page.locator(".wfoot .btn.primary")


def wait_job_end(page, timeout=240000):
    page.locator(".result").wait_for(timeout=timeout)
    return page.locator(".result").inner_text()


def job_id(page):
    return page.evaluate("location.hash").split("/")[-1]


def api_get(path):
    return json.load(urllib.request.urlopen(BASE + path.lstrip("/"), timeout=30))


# ------------------------------------------------------------------ static checks (AC-31)

def ui_source():
    """All UI source text: the static frontend/ files (index.html, app.css, js/*.js)."""
    parts = []
    for dp, _, fs in os.walk(os.path.join(ROOT, "frontend")):
        parts += [open(os.path.join(dp, f)).read() for f in sorted(fs) if f.endswith((".js", ".css", ".html"))]
    return "\n".join(parts)


def static_checks():
    src = ui_source()
    check("static: no innerHTML", "innerHTML" not in src)
    check("static: EventSource / addEventListener('end' / es.close()",
          all(s in src for s in ("EventSource", "addEventListener('end'", "es.close()")))
    check("static: no external resources", not re.search(r"""(src|href)=["']https?://""", src), "external url")
    check("static: no localStorage use", "localStorage" not in src)
    routes = set(re.findall(r'"(/api/[^"{]*)', backend_source()))
    lits = set(re.findall(r"'(/api/[^']*)'", src))
    bad = [l for l in lits if not any(r.startswith(l.split("?")[0].rstrip("/")) or l.split("?")[0] == r for r in routes)]
    check("static: every '/api/' literal is a route prefix", not bad, bad)


# ------------------------------------------------------------------ flows

def sign_in_ui(page):
    """GitLab PAT sign-in through the login screen (no OAuth configured, so Continue opens the token view)."""
    page.goto(BASE)
    wait_hash(page, "^#/login")
    soft("login: title 'Sign in — Swarm Deployer'", lambda: expect(page).to_have_title("Sign in — Swarm Deployer"))
    soft("login: #gl-continue focused", lambda: expect(page.locator("#gl-continue")).to_be_focused())
    page.locator("#gl-continue").click()
    page.locator("#gl-url").fill(ENV["gitlab"]["url"])
    page.locator("#gl-pat").fill(ENV["gitlab"]["pat"])
    page.get_by_role("button", name="Sign in with GitLab token").click()
    wait_hash(page, "^#/dashboard$")
    soft("login: toast 'Signed in as @sdtest-dev'", lambda: expect(page.get_by_text("Signed in as @sdtest-dev").first).to_be_visible())


def settings_flow(page):
    sign_in_ui(page)
    page.goto(BASE + "#/dashboard")
    soft("AC-27 fresh data dir shows setup checklist", lambda: expect(page.get_by_text("Get ready to deploy")).to_be_visible())
    check("setup checklist has 3 Set up links", page.locator(".setup a.btn").count() == 3, page.locator(".setup a.btn").count())
    shot(page, "01_setup_checklist")

    page.locator(".setup a.btn").first.click()
    wait_hash(page, "^#/settings/file-server$")
    expect(page.locator("#fs-host")).to_be_visible()
    page.locator("#fs-host").fill(FS["host"])
    page.locator("#fs-port").fill(str(FS["port"]))
    page.locator("#fs-username").fill(FS["user"])
    page.locator("#fs-password").fill("wrong-pass")
    page.locator("#fs-dir").fill(FS["remote_dir"])
    fs = page.locator("#file-server")
    fs.get_by_role("button", name="Test connection").click()
    soft("file server test with wrong password shows failure", lambda: expect(fs.locator(".test-res.bad")).to_be_visible(timeout=25000))
    page.locator("#fs-password").fill(FS["password"])
    fs.get_by_role("button", name="Test connection").click()
    soft("file server Test connection ok", lambda: expect(fs.locator(".test-res.ok")).to_be_visible(timeout=25000))
    check("file server test message mentions host", "127.0.0.1" in fs.locator(".test-res").inner_text(), fs.locator(".test-res").inner_text())
    shot(page, "02_settings_fs_test_ok")
    fs.get_by_role("button", name="Save").click()
    soft("file server saved", lambda: expect(fs.get_by_text("Saved.")).to_be_visible())
    check("password field cleared after save", page.locator("#fs-password").input_value() == "")
    soft("saved password placeholder", lambda: expect(page.locator("#fs-password")).to_have_attribute("placeholder", re.compile("saved")))
    page.locator("#fs-protocol-l").count()
    page.locator("#file-server input[value=ftp]").check(force=True)
    soft("FTP shows unencrypted warning", lambda: expect(fs.get_by_text("FTP sends the password unencrypted.")).to_be_visible())
    check("protocol switch keeps a hand-edited port", page.locator("#fs-port").input_value() == str(FS["port"]), page.locator("#fs-port").input_value())
    page.locator("#file-server input[value=sftp]").check(force=True)  # not saved: reload re-reads config

    # target
    tg = page.locator("#targets")
    tg.get_by_role("button", name="Add target").click()
    page.locator("#tg-id").fill("lab")
    page.locator("#tg-name").fill("Lab swarm")
    page.locator("#tg-host").fill(TG["host"])
    page.locator("#tg-port").fill(str(TG["port"]))
    page.locator("#tg-username").fill(TG["user"])
    page.locator("#tg-password").fill(TG["password"])
    page.locator("#tg-work").fill("/home/deploy/sd-ui-work")
    page.locator("#tg-backup").fill("/home/deploy/sd-ui-backups")
    soft("auto_add policy warning shown", lambda: expect(tg.get_by_text("Fine for a lab")).to_be_visible())
    shot(page, "03_settings_target_form")
    tg.get_by_role("button", name="Add target").last.click()
    soft("target saved and listed", lambda: expect(tg.get_by_text("Lab swarm")).to_be_visible())
    tg.get_by_role("button", name="Test").click()
    soft("target Test ok + swarm manager", lambda: expect(tg.locator(".test-res.ok")).to_contain_text("swarm manager", timeout=30000))

    # mapping
    mp = page.locator("#mappings")
    mp.get_by_role("button", name="Add mapping").click()
    page.locator("#mp-package").fill("sdtest-web1")
    page.locator("#mp-svc").fill("sdtest_web1")
    page.locator("#mp-repo").fill("Bad/Repo")
    mp.get_by_role("button", name="Save mapping").click()
    soft("mapping validation: uppercase repo rejected", lambda: expect(page.locator("#mp-repo-err")).to_be_visible())
    page.locator("#mp-repo").fill("sdtest/web1")
    page.locator("#mp-health").fill(ENV["services"]["sdtest-web1"]["health_url"])
    soft("mapping preview line", lambda: expect(mp.locator(".preview")).to_contain_text("sdtest/web1:<version> + :latest"))
    mp.get_by_role("button", name="Save mapping").click()
    soft("mapping saved and listed", lambda: expect(mp.get_by_text("sdtest_web1 @ lab")).to_be_visible())

    # options: shorter timeouts for the lab
    page.locator("#op-conv").fill(str(ENV["options"]["converge_timeout"]))
    page.locator("#op-mon").fill(str(ENV["options"]["update_monitor"]))
    page.locator("#op-ht").fill(str(ENV["options"]["health_timeout"]))
    page.locator("#options").get_by_role("button", name="Save").click()
    soft("options saved", lambda: expect(page.locator("#options").get_by_text("Saved.")).to_be_visible())
    shot(page, "04_settings_done")

    cfg = json.dumps(api_get("/api/config"))
    check("config API never returns stored passwords", FS["password"] not in cfg and TG["password"] not in cfg)

    page.goto(BASE + "#/dashboard")
    soft("AC-27 checklist gone, Services listed", lambda: expect(page.locator(".srow").first).to_be_visible(timeout=25000))
    soft("services row shows sdtest-web1 → sdtest_web1 @ lab", lambda: expect(page.locator(".srow").first).to_contain_text("sdtest_web1 @ lab"))
    cur = tdocker("service", "inspect", "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}", "sdtest_web1").split("@")[0]
    soft("services row shows the current version tag", lambda: expect(page.locator(".srow .ver").first).to_have_text(cur.rsplit(":", 1)[1]))
    soft("services row line2 1/1 running", lambda: expect(page.locator(".srow .line2").first).to_contain_text("1/1 running"))
    shot(page, "05_dashboard_services")
    return cur


def pick_package(page, path):
    page.locator(".prow").first.wait_for(timeout=25000)
    page.locator(f"input[type=radio][value='{path}']").check()


def deploy_via_wizard(page, path, password, prefix=None, mobile=False):
    page.goto(BASE + "#/dashboard")
    page.get_by_role("button", name="New deploy").click()
    wait_hash(page, "^#/new/package$")
    page.locator(".prow").first.wait_for(timeout=25000)
    if prefix:
        groups = page.locator(".pgroup h2").all_inner_texts()
        check(f"{prefix}: packages grouped by service", any("sdtest-web1" in g for g in groups), groups)
        rows = [r.split(" ·")[0] for r in page.locator(".pgroup").filter(has_text="sdtest-web1").first.locator(".prow .mono").all_inner_texts()]
        check(f"{prefix}: web1 packages newest first", rows == sorted(rows, reverse=True) and len(rows) >= 4, rows)
        check(f"{prefix}: Latest badge on the newest row", page.locator(".pgroup").first.locator(".prow").first.locator(".badge").count() == 1)
        soft(f"{prefix}: folder row archive/ shown", lambda: expect(page.locator(".drow").filter(has_text="archive/")).to_be_visible())
        soft(f"{prefix}: unmapped service flagged", lambda: expect(page.locator(".badge.warn").first).to_have_text("Not mapped"))
        next_btn(page).click()
        soft(f"{prefix}: no selection error", lambda: expect(page.locator("#pkg-err")).to_contain_text("Choose a package"))
        shot(page, prefix + "_1_package")
        if mobile:
            no_hscroll(page, "wizard package")
    pick_package(page, path)
    next_btn(page).click()
    wait_hash(page, "^#/new/password$")
    if prefix:
        next_btn(page).click()
        soft(f"{prefix}: empty password error", lambda: expect(page.locator("#zip_password-err")).to_contain_text("Enter the zip password."))
    page.locator("#zip_password").fill(password)
    if prefix:
        shot(page, prefix + "_2_password")
        if mobile:
            no_hscroll(page, "wizard password")
    page.locator("#zip_password").press("Enter")
    wait_hash(page, "^#/new/target$")
    soft("target step shows Now running", lambda: expect(page.locator("#tgt .status-line")).to_contain_text("Now running", timeout=25000))
    if prefix:
        shot(page, prefix + "_3_target")
        if mobile:
            no_hscroll(page, "wizard target")
    next_btn(page).click()
    wait_hash(page, "^#/new/review$")
    soft("review shows tag transition", lambda: expect(page.locator("dl.review")).to_contain_text("→ sdtest/web1:", timeout=20000))
    soft("review shows automatic rollback line", lambda: expect(page.locator("dl.review")).to_contain_text("Automatic rollback to"))
    if prefix:
        shot(page, prefix + "_4_review")
        if mobile:
            no_hscroll(page, "wizard review")
        page.reload()
        wait_hash(page, "^#/new/password$")
        soft("reload on review drops password and asks again",
             lambda: expect(page.get_by_text("For safety, the password isn't kept after a reload.")).to_be_visible())
        page.locator("#zip_password").fill(password)
        page.locator("#zip_password").press("Enter")
        wait_hash(page, "^#/new/target$")
        page.locator("#tgt .status-line").filter(has_text="Now running").wait_for(timeout=25000)
        next_btn(page).click()
        wait_hash(page, "^#/new/review$")
        page.locator("dl.review").filter(has_text="Automatic rollback").wait_for(timeout=20000)
    next_btn(page).click()
    wait_hash(page, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
    check("password not in URL/storage after deploy start",
          password not in page.url and password not in (page.evaluate("JSON.stringify(sessionStorage)") or ""))


def rollback_flow(page, row, before, before_txt):
    """Manual rollback from the service detail (AC-30). Run under soft() so one lab hiccup does not abort the rest."""
    row.get_by_role("button", name="Roll back").click()
    dlg = page.locator("#dlg")
    soft("rollback dialog text", lambda: expect(dlg).to_contain_text("Roll back sdtest_web1?"))
    soft("rollback dialog names image", lambda: expect(dlg).to_contain_text(before))
    shot(page, "13_rollback_dialog")
    page.locator("#dlg-no").click()
    check("dialog cancel closes", not page.evaluate("document.getElementById('dlg').open"))
    row.get_by_role("button", name="Roll back").click()
    page.locator("#dlg-yes").click()
    wait_hash(page, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
    soft("rollback run view h1", lambda: expect(page.locator("h1")).to_have_text("Rollback · sdtest-web1"))
    txt = wait_job_end(page, 240000)
    check("AC-30 rollback succeeded 'Rolled back sdtest_web1 to …'", "Rolled back sdtest_web1 to" in txt, txt)
    check(f"after rollback web1 serves {before_txt} again", web1_version() == before_txt, web1_version())
    shot(page, "14_rollback_success")
    page.goto(BASE + "#/services/sdtest-web1")
    soft("history now has 4 jobs incl. Rollback badge", lambda: expect(page.locator("#history .jrow")).to_have_count(4, timeout=20000))
    soft("history shows Rollback badge", lambda: expect(page.locator("#history .badge").filter(has_text="Rollback")).to_have_count(1))


def main():
    _lock = lab_lock()  # noqa: F841
    os.makedirs(SHOTS, exist_ok=True)
    for f in os.listdir(SHOTS):
        if f.endswith(".png"):
            os.remove(os.path.join(SHOTS, f))
    static_checks()
    data = tempfile.mkdtemp(prefix="sdtest-ui-")
    proc = start_server(data)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
            page = new_page(browser, "desktop")
            before = settings_flow(page)
            before_txt = web1_version()
            # deploy whichever of v2 / v1b is not running now, so every step changes what is served
            ok_pkg, ok_txt = (PKGS["web1_v1b"], "web1 v1") if before_txt == "web1 v2" else (PKGS["web1_v2"], "web1 v2")

            # wrong password first, then the right one via Try again
            deploy_via_wizard(page, ok_pkg, "not-the-password", prefix="06")
            txt = wait_job_end(page, 90000)
            check("wrong password: result card 'Deploy failed at Unlock and check image'", "failed at Unlock and check image" in txt, txt)
            check("wrong password: error says wrong zip password", "wrong zip password" in txt.lower(), txt)
            j = api_get("/api/deploys/" + job_id(page))
            st = {p["name"]: p["status"] for p in j["phases"]}
            check("wrong password: connect..verify skipped, cleanup success",
                  all(st[n] == "skipped" for n in ("connect", "transfer", "backup", "load", "tag", "deploy", "verify")) and st["cleanup"] == "success", st)
            check("wrong password: service unchanged", tdocker("service", "inspect", "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}", "sdtest_web1").split("@")[0] == before)
            shot(page, "07_run_wrong_password")
            page.get_by_role("button", name="Try again").click()
            wait_hash(page, "^#/new/password$")
            soft("Try again lands on password step with note", lambda: expect(page.get_by_text("Enter the zip password to deploy")).to_be_visible())
            page.locator("#zip_password").fill(ZIP_PW)
            page.locator("#zip_password").press("Enter")
            wait_hash(page, "^#/new/target$")
            page.locator("#tgt .status-line").filter(has_text="Now running").wait_for(timeout=25000)
            next_btn(page).click()
            wait_hash(page, "^#/new/review$")
            page.locator("dl.review").filter(has_text="Automatic rollback").wait_for(timeout=20000)
            next_btn(page).click()
            wait_hash(page, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
            ok_id = job_id(page)

            # live phases
            seen_running, seen_mixed = set(), False
            t0 = time.time()
            while time.time() - t0 < 240 and not page.locator(".result").count():
                cls = page.locator(".pstep").evaluate_all("els => els.map(e => e.className)")
                for i, c in enumerate(cls):
                    if "ps-running" in c:
                        seen_running.add(i)
                if any("ps-success" in c for c in cls) and any("ps-pending" in c for c in cls):
                    if not seen_mixed:
                        shot(page, "08_run_live")
                    seen_mixed = True
                page.wait_for_timeout(300)
            check("run view: 10 phases rendered", page.locator(".pstep").count() == 10, page.locator(".pstep").count())
            check("run view: phases turned running live (saw >=4 distinct)", len(seen_running) >= 4, sorted(seen_running))
            check("run view: success+pending mix seen while live", seen_mixed)
            txt = wait_job_end(page)
            check("AC-28 result card 'Deployed sdtest/web1:…'", "Deployed sdtest/web1:" in txt, txt)
            check("result card shows backup tag", "backup-" in txt, txt)
            check("all 10 phases green", page.locator(".pstep.ps-success").count() == 10, page.locator(".pstep.ps-success").count())
            check(f"web1 serves {ok_txt}", web1_version() == ok_txt, web1_version())
            check("tab title ✓ prefix", page.title().startswith("✓ sdtest-web1"), page.title())
            log_txt = page.locator(".log").inner_text() if page.locator(".log").is_visible() else ""
            if not log_txt:
                page.locator(".logbar").get_by_role("button", name=re.compile("Show")).click()
                log_txt = page.locator(".log").inner_text()
            check("log shows phase headers and docker commands", "==> [deploy] started" in log_txt and "$ [" in log_txt and "JOB SUCCESS" in log_txt, log_txt[-300:])
            check("zip password not in log", ZIP_PW not in log_txt)
            shot(page, "09_run_success")
            page.reload()
            wait_hash(page, "^#/deploys/" + ok_id + "$")
            soft("reload keeps run route and result", lambda: expect(page.locator(".result.ok")).to_be_visible())
            page.locator(".pstep").nth(4).click()  # jump to backup in log
            page.get_by_role("link", name="Back to dashboard").first.click()
            wait_hash(page, "^#/dashboard$")
            new_tag = api_get("/api/deploys/" + ok_id)["version"]
            soft("dashboard row shows the new version", lambda: expect(page.locator(".srow .ver").first).to_have_text(new_tag, timeout=25000))
            soft("recent deploys lists both jobs", lambda: expect(page.locator(".jrow")).to_have_count(2))
            soft("stat tiles: 2 total", lambda: expect(page.locator(".tile .num").first).to_have_text("2"))
            shot(page, "10_dashboard_after")

            # broken package → automatic rollback
            deploy_via_wizard(page, PKGS["web1_broken"], ZIP_PW)
            txt = wait_job_end(page, 300000)
            check("AC-29 'Deploy failed at Verify rollout'", "Deploy failed at Verify rollout" in txt, txt)
            check("AC-29 'Rolled back to sdtest/web1:…'", re.search(r"Rolled back to sdtest/web1:\S+ ✓", txt), txt)
            check(f"broken: web1 still serves {ok_txt}", web1_version() == ok_txt, web1_version())
            check("tab title ✗ prefix", page.title().startswith("✗ "), page.title())
            shot(page, "11_run_failed_rollback")
            page.get_by_role("button", name="Show in log").click()
            page.wait_for_timeout(300)

            # service detail → backups → rollback
            page.goto(BASE + "#/services/sdtest-web1")
            soft("service detail: Running now card", lambda: expect(page.locator("#now-h")).to_be_visible())
            page.locator("#backups .lrow").first.wait_for(timeout=30000)
            nb = page.locator("#backups .lrow").count()
            check("service detail: backups listed (>=2 from our deploys)", nb >= 2, nb)
            soft("history lists all 3 jobs", lambda: expect(page.locator("#history .jrow")).to_have_count(3))
            shot(page, "12_service_detail")
            # roll back to the backup made by the successful deploy (previous_image = original image)
            # newest backup whose previous_image is exactly the image we started from (the successful deploy's backup)
            prev_span = page.locator(".main span.mono[data-k=image]", has_text=re.compile("^" + re.escape(before) + "$"))
            row = page.locator("#backups .lrow").filter(has=prev_span).first
            soft("backup rows label image and tag", lambda: expect(page.locator("#backups .lrow").first).to_contain_text("Restores"))
            soft("manual rollback flow completed", lambda: rollback_flow(page, row, before, before_txt))

            # misc routes
            page.goto(BASE + "#/nope")
            wait_hash(page, "^#/dashboard$")
            check("unknown route → dashboard", True)
            page.goto(BASE + "#/settings/mappings")
            page.reload()
            wait_hash(page, "^#/settings/mappings$")
            soft("reload keeps settings route", lambda: expect(page.locator("#mappings")).to_be_visible())
            page.goto(BASE + "#/deploys/" + "0" * 32)
            soft("unknown deploy id → not found state", lambda: expect(page.get_by_text("Deploy not found")).to_be_visible())

            # dark mode
            dk = new_page(browser, "dark", color_scheme="dark")
            for r, n in (("#/dashboard", "15_dark_dashboard"), ("#/deploys/" + ok_id, "16_dark_run"), ("#/settings", "17_dark_settings"),
                         ("#/services/sdtest-web1", "18_dark_service")):
                dk.goto(BASE + r)
                dk.wait_for_timeout(2500)
                shot(dk, n)
            bg = dk.evaluate("getComputedStyle(document.body).backgroundColor")
            check("dark mode body background is dark", sum(int(x) for x in re.findall(r"\d+", bg)[:3]) < 150, bg)

            # mobile 375
            mb = new_page(browser, "mobile", viewport={"width": 375, "height": 812})
            for r, n in (("#/dashboard", "dashboard"), ("#/settings", "settings"), ("#/services/sdtest-web1", "service"), ("#/deploys/" + ok_id, "run")):
                mb.goto(BASE + r)
                mb.wait_for_timeout(2500)
                no_hscroll(mb, n)
                shot(mb, "19_mobile_" + n)
            mb.goto(BASE + "#/dashboard")
            mb.get_by_role("button", name="New deploy").click()
            wait_hash(mb, "^#/new/package$")
            mb.locator(".prow").first.wait_for(timeout=25000)
            no_hscroll(mb, "wizard package")
            shot(mb, "20_mobile_wizard_package")
            pick_package(mb, PKGS["web1_v2"])
            next_btn(mb).click()
            wait_hash(mb, "^#/new/password$")
            mb.locator("#zip_password").fill("x")
            mb.locator("#zip_password").press("Escape")
            soft("Esc with dirty draft → discard dialog", lambda: expect(mb.locator("#dlg")).to_contain_text("Discard this deploy?"))
            shot(mb, "21_mobile_discard_dialog")
            mb.locator("#dlg-yes").click()
            wait_hash(mb, "^#/dashboard$")
            check("discard clears password field from DOM", mb.locator("#zip_password").count() == 0)
            browser.close()
    finally:
        proc.terminate()
        proc.wait(10)
        leaks = subprocess.run(["grep", "-rl", "-e", ZIP_PW, data], capture_output=True, text=True).stdout
        check("zip password nowhere in data dir", not leaks.strip(), leaks)
        leaks = subprocess.run(["grep", "-rl", "--exclude=config.json", "-e", FS["password"], "-e", TG["password"], data], capture_output=True, text=True).stdout
        check("stored passwords only in config.json", not leaks.strip(), leaks)
        cj = os.path.join(data, "config.json")
        check("config.json mode 600", os.path.exists(cj) and oct(os.stat(cj).st_mode & 0o777) == "0o600", oct(os.stat(cj).st_mode) if os.path.exists(cj) else "missing")
        shutil.rmtree(data, ignore_errors=True)

    # the deliberate unknown-deploy check makes Chrome log its 404; that is the browser, not the app
    real = [c for c in CONSOLE if "/api/deploys/" + "0" * 32 not in c]
    check("zero console errors (besides the deliberate 404 probe)", not real, real[:5])
    for c in CONSOLE:
        print("  ", c)
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} passed. Screenshots: {SHOTS}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
