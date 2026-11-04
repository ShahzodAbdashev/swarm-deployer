"""Browser test of the new GitLab / SMB / registry screens in BOTH apps (TESTENV.md §11, U1-U32).
Run:  <pwvenv>/bin/python tests/ui_gitlab_test.py
  pwvenv = a venv with `pip install playwright paramiko` (uses /usr/bin/google-chrome, no browser download).
Needs the lab up and seeded (flock -o $L/lab.lock testenv/up.sh --node2; testenv/seed.sh).
Swarm commands only inside sdtest-* containers (tdocker / docker exec sdtest-target)."""
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from full_chain_test import (App, BP_PY, BP_ROOT, ENV, L, RESULTS, ROOT, ZIP_PW, check, clean_env,  # noqa: E402
                             lab_lock, run, wait_done)

GL, REG, SMB = ENV["gitlab"], ENV["registry"], ENV["file_server"]["smb"]
GL_URL, PAT = GL["url"], GL["pat"]
SD_PY = os.path.join(ROOT, ".venv/bin/python")
SHOTS = os.path.join(L, "shots", "gl")
UI_DIR = os.path.join(ENV["file_server"]["local_root"], "ui-gl")
PRELOAD = os.path.join(L, "gl-preload.tar")
PROJECT = "sdtest/apps/mock-web3"
CONSOLE, HOST_IMAGES = [], set()
expect.set_options(timeout=15000)


def soft(name, fn):
    try:
        fn()
        return check(name, True)
    except Exception as e:  # noqa: BLE001
        return check(name, False, str(e).splitlines()[0][:300])


def new_page(browser, base, name, **ctx):
    c = browser.new_context(viewport=ctx.pop("viewport", {"width": 1280, "height": 900}), **ctx)
    c.grant_permissions(["clipboard-read", "clipboard-write"], origin=base.rstrip("/"))
    p = c.new_page()
    p.on("console", lambda m: m.type == "error" and CONSOLE.append(f"[{name}] {m.text} @ {m.location.get('url', '')}"))
    p.on("pageerror", lambda e: CONSOLE.append(f"[{name}] pageerror: {e}"))
    return p


def shot(page, name):
    page.wait_for_timeout(250)
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


def wait_hash(page, pattern, timeout=15000):
    page.wait_for_function("re => new RegExp(re).test(location.hash)", arg=pattern, timeout=timeout)
    page.wait_for_timeout(100)


def no_hscroll(page, label):
    w = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    check(f"375px no horizontal scroll: {label}", w[0] <= w[1], w)


def next_btn(page):
    return page.locator(".wfoot .btn.primary")


def gl_pat_login(page, url, pat):
    """The one helper both apps share (identical login ids)."""
    if page.locator("#gl-use-token").is_visible():
        page.locator("#gl-use-token").click()
    else:
        page.locator("#gl-continue").click()
    page.locator("#gl-url").fill(url)
    page.locator("#gl-pat").fill(pat)
    page.get_by_role("button", name="Sign in with GitLab token").click()


def account_menu_text(page):
    page.get_by_role("button", name="Account menu").click()
    t = page.locator("[role=menu]").inner_text()
    page.keyboard.press("Escape")
    return t


def sign_out(page):
    page.get_by_role("button", name="Account menu").click()
    page.get_by_role("menuitem", name="Sign out").click()


def write_atomic(path, data):
    tmp = path + ".tmp-copy"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# ---------------------------------------------------------------- Build Packager (U1-U13)

def bp_flow(browser, bp):
    B = f"http://127.0.0.1:{bp.port}/"
    p = new_page(browser, B, "bp")
    # U1
    p.goto(B)
    wait_hash(p, "^#/login")
    order = p.evaluate("""() => { const g = document.getElementById('gl-continue');
        const h = [...document.querySelectorAll('button')].find(b => /Continue with GitHub/.test(b.textContent));
        return !!(g && h && (g.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)); }""")
    check("U1 BP login: #gl-continue before the GitHub button", order)
    soft("U1 #gl-continue focused (OAuth configured)", lambda: expect(p.locator("#gl-continue")).to_be_focused())
    check("U1 exactly one <details>", p.locator("details").count() == 1, p.locator("details").count())
    soft("U1 #gl-use-token visible", lambda: expect(p.locator("#gl-use-token")).to_be_visible())
    shot(p, "bp_01_login")
    # U2
    p.locator("#gl-use-token").click()
    p.get_by_role("button", name="Sign in with GitLab token").click()
    soft("U2 empty submit -> 'Paste a token first.'", lambda: expect(p.locator("#gl-pat-err")).to_contain_text("Paste a token first."))
    p.locator("#gl-url").fill(GL_URL)
    p.locator("#gl-pat").fill("glpat-not-a-real-token")
    p.get_by_role("button", name="Sign in with GitLab token").click()
    soft("U2 bad PAT -> 'GitLab rejected this token'", lambda: expect(p.locator(".alert")).to_contain_text("GitLab rejected this token"))
    p.locator("#gl-pat").fill(PAT)
    p.get_by_role("button", name="Sign in with GitLab token").click()
    wait_hash(p, "^#/dashboard$")
    soft("U2 toast 'Signed in as @sdtest-dev'", lambda: expect(p.get_by_text("Signed in as @sdtest-dev").first).to_be_visible())
    check("U2 account menu 'Signed in as @sdtest-dev'", "Signed in as @sdtest-dev" in account_menu_text(p))
    sign_out(p)
    wait_hash(p, "^#/login")
    check("U2 sign out -> #/login", True)
    # U3 OAuth through the mock
    p.locator("#gl-continue").click()
    wait_hash(p, "^#/dashboard$", timeout=20000)
    check("U3 OAuth: start -> mock -> callback -> #/dashboard", p.url.startswith(B), p.url)
    # U4
    p.get_by_role("button", name="New build").first.click()
    wait_hash(p, "^#/new/repo$")
    opt = p.locator("#repo-list li[role=option]", has_text=PROJECT)
    soft("U4 repo list shows sdtest/apps/mock-web3", lambda: expect(opt.first).to_be_visible(timeout=20000))
    opt.first.click()
    if not p.evaluate("location.hash").startswith("#/new/source"):
        next_btn(p).click()
    wait_hash(p, "^#/new/source$")
    # U5
    soft("U5 branch select has v2", lambda: expect(p.locator("#branch option[value=v2]")).to_have_count(1, timeout=20000))
    p.locator("#branch").select_option("v2")
    p.locator("#service").fill("sdtest-web3")
    glm = p.locator("input[name=env_mode][value=gitlab]")
    soft("U5 'From GitLab CI' option shown", lambda: expect(glm).to_be_attached())
    glm.check(force=True)
    soft("U5 #env_job = export_env", lambda: expect(p.locator("#env_job")).to_have_value("export_env"))

    def gen():
        p.locator("#env-gen").click()
        expect(p.locator("#env-keys .env-row").first).to_be_visible(timeout=20000)
        p.wait_for_timeout(300)
    gen()
    rows = p.locator("#env-keys .env-row")
    check("U5 5 .env rows, all masked", rows.count() == 5 and all("••••" in t for t in rows.all_inner_texts()), rows.all_inner_texts())
    check("U5 secret value not on the page", "sdtest-mongo-secret-42" not in p.content())
    check("U5 #env-missing hidden", p.locator("#env-missing").count() == 0 or not p.locator("#env-missing").is_visible())
    shot(p, "bp_05_env_gitlab")
    # U6
    p.locator("#branch").select_option("unhealthy")
    soft("U6 branch change drops the .env generated for v2 (no stale rows)",
         lambda: expect(p.locator("#env-keys .env-row")).to_have_count(0))
    gen()
    soft("U6 unhealthy: #env-missing names WEB3_MONGO_HOST_TYPO",
         lambda: expect(p.locator("#env-missing")).to_contain_text("WEB3_MONGO_HOST_TYPO"))
    check("U6 one .env-row.missing", p.locator(".env-row.missing").count() == 1, p.locator(".env-row.missing").count())
    p.locator("#branch").select_option("v2")
    gen()
    # U7
    store = p.evaluate("sessionStorage.getItem('bp.draft') || ''")
    check("U7 draft in sessionStorage has no .env value", "sdtest-mongo-secret-42" not in store and bool(store), store[:200])
    p.reload()
    wait_hash(p, "^#/new/source$")
    p.locator("#service").wait_for()
    next_btn(p).click()
    soft("U7 after reload: #env-err 'Add the .env content'", lambda: expect(p.locator("#env-err")).to_contain_text("Add the .env content"))
    gen()
    # U8 Advanced
    if not p.locator("#env_path").is_visible():
        p.locator("#adv summary").click()
    soft("U8 #env_path = .env", lambda: expect(p.locator("#env_path")).to_have_value(".env"))
    p.locator("#preload_tars").fill("relative.tar")
    next_btn(p).click()
    soft("U8 relative preload path rejected", lambda: expect(p.locator("#preload_tars-err")).to_contain_text("absolute path"))
    p.locator("#preload_tars").fill(PRELOAD)
    soft("U8 Advanced summary '1 set'", lambda: expect(p.locator("#adv summary")).to_contain_text("1 set"))
    shot(p, "bp_08_advanced")
    # U9
    next_btn(p).click()
    wait_hash(p, "^#/new/password$")
    p.locator("#password").fill(ZIP_PW)
    p.locator("#password_confirm").fill(ZIP_PW)
    p.locator("#password_confirm").press("Enter")
    wait_hash(p, "^#/new/upload$")
    want_up = f"smb://files@127.0.0.1:{SMB['port']}/releases/ui-gl"  # the upload step shows the user too
    soft("U9 upload step target smb://…/releases/ui-gl", lambda: expect(p.locator("main")).to_contain_text(want_up))
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    soft("U9 review .env row '5 keys → .env (from GitLab CI)'",
         lambda: expect(p.locator("dl.review")).to_contain_text("5 keys → .env (from GitLab CI)"))
    shot(p, "bp_09_review")
    next_btn(p).click()
    wait_hash(p, "^#/jobs/[0-9a-f]{32}$", timeout=20000)
    jid = p.evaluate("location.hash").split("/")[-1]
    job = wait_done(bp, f"/api/jobs/{jid}", 600)
    if job.get("image_tag"):
        HOST_IMAGES.add(job["image_tag"])
    soft("U9 run view: success card", lambda: expect(p.locator(".result.ok")).to_be_visible(timeout=30000))
    sts = p.eval_on_selector_all(".pstep", "els => els.map(e => e.className)")
    check("U9 7 steps, none failed", len(sts) == 7 and not any("failed" in s for s in sts), sts)
    soft("U9 #res-env '5 keys'", lambda: expect(p.locator("#res-env")).to_contain_text("5 keys"))
    soft("U9 #res-hc shown", lambda: expect(p.locator("#res-hc")).to_be_visible())
    zips = [f for f in os.listdir(UI_DIR) if f.endswith(".zip")] if os.path.isdir(UI_DIR) else []
    check("U9 zip landed in releases/ui-gl over SMB", len(zips) == 1, zips)
    shot(p, "bp_09_run")
    # U9b rebuild
    p.get_by_role("button", name="Rebuild").first.click()
    wait_hash(p, "^#/new/source$")
    soft("U9b rebuild note 'Add the .env again'", lambda: expect(p.get_by_text("Add the .env again; it isn't kept.")).to_be_visible())
    soft("U9b gitlab mode kept", lambda: expect(p.locator("input[name=env_mode][value=gitlab]")).to_be_checked())
    check("U9b no .env content kept", p.locator("#env_content").count() == 0 or p.locator("#env_content").input_value() == "")
    # U9c .env "File or paste" mode, upload a file: v2 code with MONGO_HOST empty = an unhealthy image (U28b)
    p.locator("input[name=env_mode][value=content]").check(force=True)
    envf = os.path.join(L, "ui-gl-unhealthy.env")
    with open(envf, "w") as f:
        f.write("SVC_PORT=8084\nGREETING=hello\nMONGO_HOST=\nMONGO_PASSWORD=sdtest-mongo-secret-42\nAPP_ENV=development\n")
    p.locator("#env_file").set_input_files(envf)
    os.remove(envf)
    soft("U9c file upload: 5 .env rows, values masked", lambda: (expect(p.locator("#env-keys .env-row")).to_have_count(5),
                                                                 expect(p.locator("#env-keys .mask").first).to_be_visible()))
    check("U9c secret from the file not on the page", "sdtest-mongo-secret-42" not in p.content())
    next_btn(p).click()
    wait_hash(p, "^#/new/password$")
    p.locator("#password").fill(ZIP_PW)
    p.locator("#password_confirm").fill(ZIP_PW)
    p.locator("#password_confirm").press("Enter")
    wait_hash(p, "^#/new/upload$")
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    soft("U9c review .env row '5 keys → .env (from file)'",
         lambda: expect(p.locator("dl.review")).to_contain_text("5 keys → .env (from file)"))
    next_btn(p).click()
    wait_hash(p, "^#/jobs/[0-9a-f]{32}$", timeout=20000)
    job = wait_done(bp, f"/api/jobs/{p.evaluate('location.hash').split('/')[-1]}", 600)
    if job.get("image_tag"):
        HOST_IMAGES.add(job["image_tag"])
    soft("U9c file build: success card, #res-env '5 keys'", lambda: (expect(p.locator(".result.ok")).to_be_visible(timeout=30000),
                                                                    expect(p.locator("#res-env")).to_contain_text("5 keys")))
    check("U9c job.env source file", (job.get("env") or {}).get("source") == "file", job.get("env"))
    unh = os.path.basename((job.get("artifacts") or {}).get("remote_path") or "")
    p.goto(B + "#/dashboard")
    wait_hash(p, "^#/dashboard$")
    # U10 settings
    p.goto(B + "#/settings")
    p.locator("#host").wait_for()
    soft("U10 protocol smb from .env", lambda: expect(p.locator("input[name=protocol][value=smb]")).to_be_checked())
    soft("U10 #share = releases", lambda: expect(p.locator("#share")).to_have_value("releases"))
    soft("U10 #domain visible", lambda: expect(p.locator("#domain")).to_be_visible())
    p.get_by_role("button", name="Test connection").click()
    soft("U10 Test connection ok", lambda: expect(p.locator(".test-res.ok")).to_be_visible(timeout=25000))
    p.locator("input[name=protocol][value=sftp]").check(force=True)
    soft("U10 SFTP hides #share, port 22", lambda: (expect(p.locator("#share")).to_be_hidden(), expect(p.locator("#port")).to_have_value("22")))
    p.locator("input[name=protocol][value=smb]").check(force=True)
    soft("U10 back to SMB: port 445", lambda: expect(p.locator("#port")).to_have_value("445"))
    shot(p, "bp_10_settings")
    p.reload()
    p.locator("#host").wait_for()
    # U11 import .env
    p.locator("#env-import-text").fill("FILE_SERVER_REMOTE_DIR=/ui-gl2\n")
    p.locator("#env-import").get_by_role("button", name="Import .env").click()
    soft("U11 result 'Set: upload.remote_dir'", lambda: expect(p.locator("#env-import-res")).to_contain_text("Set: upload.remote_dir"))
    soft("U11 #remote_dir shows /ui-gl2", lambda: expect(p.locator("#remote_dir")).to_have_value("/ui-gl2"))
    soft("U11 textarea cleared", lambda: expect(p.locator("#env-import-text")).to_have_value(""))
    # U12
    soft("U12 #gl-cfg-url has the mock URL", lambda: expect(p.locator("#gl-cfg-url")).to_contain_text(GL_URL))
    soft("U12 #gl-redirect ends with the callback path", lambda: expect(p.locator("#gl-redirect")).to_have_text(re.compile(r"/api/auth/gitlab/callback$")))
    shot(p, "bp_12_settings_gitlab")
    # U13 at 375 px
    m = new_page(browser, B, "bp-mobile", viewport={"width": 375, "height": 812})
    for r, n in (("#/new/source", "source step"), ("#/settings", "settings")):
        m.goto(B + r)
        m.wait_for_timeout(2000)
        no_hscroll(m, "BP " + n)
    sign_out(p)
    wait_hash(p, "^#/login")
    m = new_page(browser, B, "bp-mobile-login", viewport={"width": 375, "height": 812})
    m.goto(B + "#/login")
    m.wait_for_timeout(1500)
    no_hscroll(m, "BP login")
    return (zips[0], unh) if zips else None


# ---------------------------------------------------------------- Swarm Deployer (U20-U32)

def sd_flow(browser, sd, zips):
    bp_zip, unh_zip = zips
    B = f"http://127.0.0.1:{sd.port}/"
    p = new_page(browser, B, "sd")
    # U20
    p.goto(B)
    wait_hash(p, "^#/login")
    check("U20 SD login without OAuth: no #gl-use-token", p.locator("#gl-use-token").count() == 0)
    check("U20 title", p.title() == "Sign in — Swarm Deployer", p.title())
    p.locator("#gl-continue").click()
    soft("U20 token view with #gl-url prefilled", lambda: (expect(p.locator("#gl-token")).to_be_visible(),
                                                         expect(p.locator("#gl-url")).to_have_value(GL_URL)))
    shot(p, "sd_20_login")
    p.get_by_role("button", name="Back").click()
    # U21
    gl_pat_login(p, GL_URL, PAT)
    wait_hash(p, "^#/dashboard$")
    soft("U21 setup checklist keeps 3 a.btn", lambda: expect(p.locator(".setup a.btn")).to_have_count(3))
    check("U21 account menu 'Signed in as @sdtest-dev'", "Signed in as @sdtest-dev" in account_menu_text(p))
    # U22 import .env
    p.goto(B + "#/settings/import")
    imp = p.locator("#import")
    imp.locator("#ie-text").fill("\n".join([
        "FILE_SERVER_PROTOCOL=smb", "FILE_SERVER_HOST=127.0.0.1", f"FILE_SERVER_PORT={SMB['port']}",
        "FILE_SERVER_USER=files", f"FILE_SERVER_PASSWORD={SMB['password']}", "FILE_SERVER_SHARE=releases",
        "FILE_SERVER_REMOTE_DIR=/ui-gl", "SD_TARGET_ID=lab", "SD_TARGET_HOST=127.0.0.1", f"SD_TARGET_PORT={ENV['target']['port']}",
        "SD_TARGET_USER=deploy", "SD_HOST_KEY_POLICY=auto_add", "SD_WORK_DIR=/home/deploy/sd-ui-work",
        "SD_BACKUP_DIR=/home/deploy/sd-ui-backups", ""]))
    imp.get_by_role("button", name="Import .env").click()
    res = p.locator("#ie-result .test-res.ok")
    soft("U22 result lists file_server.share and targets.lab.host",
         lambda: (expect(res).to_contain_text("file_server.share"), expect(res).to_contain_text("targets.lab.host")))
    soft("U22 file server card: SMB + #fs-share releases",
         lambda: (expect(p.locator("#file-server input[value=smb]")).to_be_checked(), expect(p.locator("#fs-share")).to_have_value("releases")))
    # U23 import from GitLab
    soft("U23 #ie-project lists the project", lambda: expect(p.locator(f"#ie-project option[value='{PROJECT}']")).to_have_count(1, timeout=20000))
    p.locator("#ie-project").select_option(PROJECT)
    p.locator("#import").get_by_role("button", name="Import from GitLab").click()
    soft("U23 result lists targets.lab.registry.url", lambda: expect(p.locator("#ie-result")).to_contain_text("targets.lab.registry.url", timeout=20000))
    tg = p.locator("#targets")
    soft("U23 target row 'registry 127.0.0.1:5050'", lambda: expect(tg).to_contain_text("registry 127.0.0.1:5050"))
    shot(p, "sd_23_imported")
    tg.get_by_role("button", name="Edit").first.click()
    soft("U23 edit target: registry url + saved password placeholder",
         lambda: (expect(p.locator("#tg-reg-url")).to_have_value(REG["url"]),
                  expect(p.locator("#tg-reg-password")).to_have_attribute("placeholder", re.compile("saved"))))
    tg.get_by_role("button", name="Cancel").click()
    # U24 mapping
    mp = p.locator("#mappings")
    soft("U24 sdtest-web3 mapping shows @current", lambda: expect(mp).to_contain_text("@current"))
    mp.locator(".lrow, li, tr", has_text="sdtest-web3").get_by_role("button", name="Edit").first.click()
    soft("U24 #mp-moving = @current, datalist 4 options",
         lambda: (expect(p.locator("#mp-moving")).to_have_value("@current"), expect(p.locator("#mp-moving-list option")).to_have_count(4)))
    mp.get_by_role("button", name="Cancel").click()
    # U25
    fs = p.locator("#file-server")
    fs.get_by_role("button", name="Test connection").click()
    soft("U25 SMB Test connection ok", lambda: expect(fs.locator(".test-res.ok")).to_be_visible(timeout=25000))
    # U25b type the SMB server and registry credentials by hand (no .env), save, reload
    fs.locator("#fs-host").fill("127.0.0.1")
    fs.locator("#fs-port").fill(str(SMB["port"]))
    fs.locator("#fs-username").fill("files")
    fs.locator("#fs-password").fill(SMB["password"])
    fs.locator("#fs-share").fill("releases")
    fs.locator("#fs-dir").fill("/ui-gl")
    fs.get_by_role("button", name="Save", exact=True).click()
    soft("U25b manual SMB saved", lambda: expect(fs.get_by_text("Saved.")).to_be_visible())
    tg.get_by_role("button", name="Edit").first.click()
    p.locator("#tg-reg-user").fill(REG["user"])
    p.locator("#tg-reg-password").fill(REG["password"])
    tg.get_by_role("button", name="Save target").click()
    soft("U25b registry saved", lambda: expect(tg).to_contain_text("registry " + REG["url"]))
    p.reload()
    p.locator("#fs-host").wait_for()
    soft("U25b after reload: SMB values kept, password + registry password '(saved)'",
         lambda: (expect(p.locator("#fs-share")).to_have_value("releases"), expect(p.locator("#fs-dir")).to_have_value("/ui-gl"),
                  expect(p.locator("#fs-password")).to_have_attribute("placeholder", re.compile("saved"))))
    p.locator("#targets").get_by_role("button", name="Edit").first.click()
    soft("U25b registry user kept, password '(saved)'",
         lambda: (expect(p.locator("#tg-reg-user")).to_have_value(REG["user"]),
                  expect(p.locator("#tg-reg-password")).to_have_attribute("placeholder", re.compile("saved"))))
    p.locator("#targets").get_by_role("button", name="Cancel").click()
    fs.get_by_role("button", name="Test connection").click()
    soft("U25b SMB test still ok", lambda: expect(fs.locator(".test-res.ok")).to_be_visible(timeout=25000))
    # U26
    soft("U26 #op-prune unchecked, #op-tar checked",
         lambda: (expect(p.locator("#op-prune")).not_to_be_checked(), expect(p.locator("#op-tar")).to_be_checked()))
    shot(p, "sd_26_settings")
    # U27 live watch
    p.goto(B + "#/dashboard")
    p.get_by_role("button", name="New deploy").click()
    wait_hash(p, "^#/new/package$")
    p.locator(".prow").first.wait_for(timeout=25000)
    soft("U27 #pkg-live 'Watching'", lambda: expect(p.locator("#pkg-live")).to_contain_text("Watching", timeout=12000))
    copy = "sdtest-web3_" + time.strftime("%Y%m%d_%H%M%S") + ".zip"
    write_atomic(os.path.join(UI_DIR, copy), open(os.path.join(UI_DIR, bp_zip), "rb").read())
    try:
        soft("U27 first seen = Uploading…, radio disabled until its size holds for one poll",
             lambda: (expect(p.locator(f".prow[title='{copy}'] .badge.up")).to_be_visible(timeout=12000),
                      expect(p.locator(f".prow[title='{copy}'] input[type=radio]")).to_be_disabled()))
        soft("U27 then marked .prow.new", lambda: expect(p.locator(f".prow.new[title='{copy}']")).to_be_visible(timeout=12000))
        soft("U27 .badge.new visible", lambda: expect(p.locator(".badge.new").first).to_be_visible())
        shot(p, "sd_27_watch_new")
    finally:
        os.remove(os.path.join(UI_DIR, copy))
    # U28 deploy through the registry
    pkg = p.locator(f".prow[title='{bp_zip}']")
    pkg.wait_for(timeout=15000)
    pkg.click()
    next_btn(p).click()
    wait_hash(p, "^#/new/password$")
    p.locator("#zip_password").fill(ZIP_PW)
    p.locator("#zip_password").press("Enter")
    wait_hash(p, "^#/new/target$")
    soft("U28 #tgt-image ':dev (@current)'", lambda: expect(p.locator("#tgt-image")).to_contain_text(":dev (@current)", timeout=25000))
    soft("U28 #tgt-registry names the registry", lambda: expect(p.locator("#tgt-registry")).to_contain_text(REG["url"]))
    shot(p, "sd_28_target")
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    soft("U28 review: 'push to 127.0.0.1:5050'", lambda: expect(p.locator("dl.review")).to_contain_text("push to " + REG["url"], timeout=20000))
    next_btn(p).click()
    wait_hash(p, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
    check("U28 10 phases", p.locator(".pstep").count() == 10, p.locator(".pstep").count())
    soft("U28 tag step 'Tag and push image'", lambda: expect(p.locator(".pstep .plab").nth(6)).to_have_text("Tag and push image"))
    p.locator(".result").wait_for(timeout=300000)
    txt = p.locator(".result").inner_text()
    check("U28 result 'Deployed'", "Deployed" in txt and p.locator(".result.ok").count() == 1, txt)
    soft("U28 #run-by sdtest-dev", lambda: expect(p.locator("#run-by")).to_contain_text("sdtest-dev"))
    imgs = p.locator("#run-images").inner_text() if p.locator("#run-images").count() else ""
    check("U28 #run-images before and after by digest", imgs.count("@sha256:") >= 2, imgs)
    soft("U28 #res-digest 'Pushed sha256:'", lambda: expect(p.locator("#res-digest")).to_contain_text("Pushed sha256:"))
    logtxt = p.locator("#log-box [role=log]").text_content() or ""
    check("U28 live log console shows the push and the health script",
          f"pushed {REG['url']}/sdtest/web3:dev" in logtxt and "healthcheck: OK" in logtxt, logtxt[-400:])
    shot(p, "sd_28_run")
    # U28b unhealthy package (U9c) through the UI: verify fails, rolled back by digest
    p.goto(B + "#/dashboard")
    p.get_by_role("button", name="New deploy").click()
    wait_hash(p, "^#/new/package$")
    p.locator(f".prow[title='{unh_zip}']").click(timeout=25000)
    next_btn(p).click()
    wait_hash(p, "^#/new/password$")
    p.locator("#zip_password").fill(ZIP_PW)
    p.locator("#zip_password").press("Enter")
    wait_hash(p, "^#/new/target$")
    expect(p.locator("#tgt-image")).to_contain_text(":dev", timeout=25000)  # target step loads the service first
    next_btn(p).click()
    try:
        wait_hash(p, "^#/new/review$", timeout=30000)
    except Exception:
        shot(p, "sd_28b_target_stuck")
        raise
    p.locator("dl.review").filter(has_text="push to").wait_for(timeout=20000)
    next_btn(p).click()
    wait_hash(p, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
    p.locator(".result").wait_for(timeout=300000)
    soft("U28b failed deploy card 'Rolled back to …:dev@sha256'",
         lambda: expect(p.locator(".result")).to_contain_text(re.compile(r"Rolled back to \S+:dev@sha256:")))
    shot(p, "sd_28b_rolled_back")
    # U29
    p.goto(B + "#/dashboard")
    soft("U29 recent row 'by sdtest-dev'", lambda: expect(p.locator(".jrow").first).to_contain_text("by sdtest-dev", timeout=20000))
    p.goto(B + "#/services/sdtest-web3")
    soft("U29 backups 'in registry' badge", lambda: expect(p.locator("#backups .badge", has_text="in registry").first).to_be_visible(timeout=30000))
    # U29b manual rollback of a registry backup (back to the seeded v1)
    row = p.locator("#backups .lrow", has=p.locator(".badge", has_text="in registry")).first
    row.get_by_role("button", name="Roll back").click()
    p.locator("#dlg-yes").click()
    wait_hash(p, "^#/deploys/[0-9a-f]{32}$", timeout=20000)
    p.locator(".result").wait_for(timeout=300000)
    soft("U29b 'Rolled back sdtest_web3 to …'", lambda: expect(p.locator(".result.ok")).to_contain_text("Rolled back sdtest_web3 to"))
    imgs = p.locator("#run-images").inner_text() if p.locator("#run-images").count() else ""
    check("U29b #run-images after is by digest", "@sha256:" in imgs, imgs)
    # U31 GitLab card
    p.goto(B + "#/settings/gitlab")
    gc = p.locator("#gitlab")
    soft("U31 #gl-cfg-url has the env URL", lambda: expect(p.locator("#gl-cfg-url")).to_contain_text(GL_URL))
    p.locator("#gl-client-id").fill(GL["client_id"])
    p.locator("#gl-client-secret").fill(GL["client_secret"])
    gc.get_by_role("button", name="Save").click()
    soft("U31 Saved.", lambda: expect(gc.get_by_text("Saved.")).to_be_visible())
    p.reload()
    p.locator("#gl-client-id").wait_for()
    soft("U31 after reload: id kept, secret placeholder 'saved'",
         lambda: (expect(p.locator("#gl-client-id")).to_have_value(GL["client_id"]),
                  expect(p.locator("#gl-client-secret")).to_have_attribute("placeholder", re.compile("saved"))))
    soft("U31 #gl-redirect http://127.0.0.1:…/api/auth/gitlab/callback",
         lambda: expect(p.locator("#gl-redirect")).to_have_text(re.compile(r"^http://127\.0\.0\.1:\d+/api/auth/gitlab/callback$")))
    shot(p, "sd_31_gitlab_card")
    # U31b OAuth sign-in in the SD browser (client id now set)
    sign_out(p)
    wait_hash(p, "^#/login")
    p.locator("#gl-continue").click()
    wait_hash(p, "^#/dashboard$", timeout=20000)
    check("U31b SD OAuth: account menu 'Signed in as @sdtest-dev'", "Signed in as @sdtest-dev" in account_menu_text(p))
    p.goto(B + "#/settings/gitlab")
    p.locator("#gl-client-id").wait_for()
    p.locator("#gl-client-id").fill("")
    gc.get_by_role("button", name="Save").click()
    soft("U31 client id cleared again", lambda: expect(gc.get_by_text("Saved.")).to_be_visible())
    # U32 format (2) row
    tz = os.path.join(UI_DIR, "sdtest-web3.tar.zip")
    buf = os.path.join(L, "ui-gl-tiny.zip")
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("sdtest-web3.tar", b"not a real tar")
    write_atomic(tz, open(buf, "rb").read())
    os.remove(buf)
    try:
        p.goto(B + "#/dashboard")
        p.get_by_role("button", name="New deploy").click()
        wait_hash(p, "^#/new/package$")
        row = p.locator(".prow[title='sdtest-web3.tar.zip']")
        soft("U32 format (2) row with .badge.fmt 'tar.zip'", lambda: expect(row.locator(".badge.fmt")).to_have_text("tar.zip", timeout=12000))
        row.click()
        soft("U32 selected: 'new version (deploy time)'", lambda: expect(p.get_by_text("new version (deploy time)")).to_be_visible())
        next_btn(p).click()
        wait_hash(p, "^#/new/password$")
        soft("U32 #pw-zipcrypto help", lambda: expect(p.locator("#pw-zipcrypto")).to_be_visible())
        shot(p, "sd_32_zipcrypto")
        p.keyboard.press("Escape")
        p.locator("#dlg-yes").click()
        wait_hash(p, "^#/dashboard$")
    finally:
        os.remove(tz)
    # U30
    m = new_page(browser, B, "sd-mobile", viewport={"width": 375, "height": 812})
    m.goto(B + "#/settings")
    m.wait_for_timeout(2500)
    no_hscroll(m, "SD settings")
    sign_out(p)
    wait_hash(p, "^#/login")
    try:
        code = urllib.request.urlopen(B + "api/config", timeout=10).status
    except urllib.error.HTTPError as e:
        code = e.code
    check("U30 sign out -> #/login, /api/config 401", code == 401, code)
    m = new_page(browser, B, "sd-mobile-login", viewport={"width": 375, "height": 812})  # fresh tab: the old one still thinks it is signed in
    m.goto(B + "#/login")
    m.wait_for_timeout(1500)
    no_hscroll(m, "SD login")


def main():
    _lock = lab_lock()  # noqa: F841
    os.makedirs(SHOTS, exist_ok=True)
    snap = os.path.join(ROOT, "testenv/host_snapshot.sh")
    run("bash", snap, os.path.join(L, "uigl_snap_before.txt"))
    r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
    check("S seed.sh --reset", r.returncode == 0, r.stdout[-300:] + r.stderr[-300:])
    for d in (UI_DIR, UI_DIR + "2"):
        shutil.rmtree(d, ignore_errors=True)
    if not os.path.exists(PRELOAD):
        run("docker", "save", "busybox:latest", "-o", PRELOAD)
    bp_dir = tempfile.mkdtemp(prefix="uigl-bp-", dir=L)
    shutil.copy(os.path.join(BP_ROOT, "app.py"), bp_dir)
    shutil.copytree(os.path.join(BP_ROOT, "backend"), os.path.join(bp_dir, "backend"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(BP_ROOT, "frontend", "dist"), os.path.join(bp_dir, "frontend", "dist"))
    with open(os.path.join(bp_dir, "bp.env"), "w") as f:
        f.write("\n".join([
            f"GITLAB_URL={GL_URL}", f"GITLAB_CLIENT_ID={GL['client_id']}", f"GITLAB_CLIENT_SECRET={GL['client_secret']}",
            "FILE_SERVER_PROTOCOL=smb", "FILE_SERVER_HOST=127.0.0.1", f"FILE_SERVER_PORT={SMB['port']}",
            "FILE_SERVER_USER=files", f"FILE_SERVER_PASSWORD={SMB['password']}", "FILE_SERVER_SHARE=releases",
            "FILE_SERVER_REMOTE_DIR=/ui-gl", ""]))
    sd_data = tempfile.mkdtemp(prefix="uigl-sd-", dir=L)
    with open(os.path.join(sd_data, "sd.env"), "w") as f:
        f.write(f"GITLAB_URL={GL_URL}\n")
    bp = sd = None
    try:
        bp = App("uigl-bp", BP_PY, bp_dir, {**clean_env(), "BP_ENV_FILE": os.path.join(bp_dir, "bp.env")}, "/api/auth/status")
        sd = App("uigl-sd", SD_PY, ROOT, {**clean_env(), "SD_DATA": sd_data, "SD_ENV_FILE": os.path.join(sd_data, "sd.env")},
                 "/api/auth/status")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
            bp_zip = None
            try:
                bp_zip = bp_flow(browser, bp)  # (healthy zip, unhealthy zip)
            except Exception:  # noqa: BLE001
                import traceback
                traceback.print_exc()
                check("BP block completed without exception", False)
            if bp_zip:
                try:
                    sd_flow(browser, sd, bp_zip)
                except Exception:  # noqa: BLE001
                    import traceback
                    traceback.print_exc()
                    check("SD block completed without exception", False)
            else:
                check("SD block skipped: no BP zip from U9", False)
            browser.close()
    finally:
        for a in (bp, sd):
            if a:
                a.proc.terminate()
                a.proc.wait(10)
        for img in HOST_IMAGES:
            run("docker", "rmi", img)
        for d in (UI_DIR, UI_DIR + "2"):
            shutil.rmtree(d, ignore_errors=True)
        r = run("bash", os.path.join(ROOT, "testenv/seed.sh"), "--reset")
        check("teardown seed.sh --reset", r.returncode == 0, r.stderr[-300:])
        shutil.rmtree(bp_dir, ignore_errors=True)
        shutil.rmtree(sd_data, ignore_errors=True)
        run("bash", snap, os.path.join(L, "uigl_snap_after.txt"))
        same = open(os.path.join(L, "uigl_snap_before.txt")).read() == open(os.path.join(L, "uigl_snap_after.txt")).read()
        check("safety: host containers unchanged", same)

    # deliberate probes: the bad PAT (U2) answers 401 on the token endpoint
    real = [c for c in CONSOLE if "/api/auth/gitlab/token" not in c]
    check("U13/U30 zero console errors (besides the deliberate bad-PAT 401)", not real, real[:5])
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} passed. Screenshots: {SHOTS}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
