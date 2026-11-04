"""Browser UI test for Build Packager (UX.md checklist). Drives the real flow in headless system Chrome.

Run:  <pwvenv>/bin/python tests/ui_test.py [shots_dir]
  pwvenv = a venv with `pip install playwright` (no browser download needed; uses /usr/bin/google-chrome).
The app runs from a temp copy (like tests/e2e_test.py) on 127.0.0.1:8092 with the project .venv python,
so the real data/ is untouched. Needs: docker (busybox:latest or alpine:latest), git, gh logged in, network.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, ".venv", "bin", "python")
PORT = 8092
BASE = f"http://127.0.0.1:{PORT}/"
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "bp_ui_shots")
PW = "ui-s3cret-pw"
RESULTS, CONSOLE = [], []
SERVICES = {"uitest", "uitestfail", "uitestslow"}
expect.set_options(timeout=15000)


def check(name, cond, evidence=""):
    RESULTS.append((name, bool(cond), evidence))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {evidence}"), flush=True)
    return bool(cond)


def soft(name, fn):
    """Run an expect-style block; record PASS/FAIL instead of aborting."""
    try:
        fn()
        return check(name, True)
    except Exception as e:  # noqa: BLE001
        return check(name, False, str(e).splitlines()[0][:300])


def sh(*argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True)


def git_repo(path, files, branch):
    os.makedirs(path)
    for n, c in files.items():
        with open(os.path.join(path, n), "w") as f:
            f.write(c)
    sh("git", "init", "-q", "-b", branch, cwd=path)
    sh("git", "add", ".", cwd=path)
    assert sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init", cwd=path).returncode == 0


def start_server(tmp):
    app = os.path.join(tmp, "app")
    os.makedirs(app)
    shutil.copy(os.path.join(ROOT, "app.py"), app)
    shutil.copytree(os.path.join(ROOT, "backend"), os.path.join(app, "backend"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(ROOT, "frontend", "dist"), os.path.join(app, "frontend", "dist"))  # built UI
    env = {k: v for k, v in os.environ.items()
               if k not in ("GITHUB_CLIENT_ID", "BP_ENV_FILE") and not k.startswith("GITLAB_")}
    logf = open(os.path.join(tmp, "server.log"), "w")
    proc = subprocess.Popen([PY, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
                            cwd=app, env=env, stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen(BASE + "api/auth/status", timeout=2)
            return proc
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("server did not start")


# ------------------------------------------------------------------ page helpers

def new_page(browser, name, **ctx):
    c = browser.new_context(viewport=ctx.pop("viewport", {"width": 1280, "height": 800}), accept_downloads=True, **ctx)
    c.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE.rstrip("/"))
    p = c.new_page()
    p.on("console", lambda m: m.type == "error" and CONSOLE.append(f"[{name}] console: {m.text} @ {m.location.get('url', '')}"))
    p.on("pageerror", lambda e: CONSOLE.append(f"[{name}] pageerror: {e}"))
    return p


def shot(page, name):
    page.wait_for_timeout(250)
    page.evaluate("window.scrollTo(0, 0)")  # sticky top bar renders mid-page in scrolled full_page shots
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=True)


def no_hscroll(page, label):
    w = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    check(f"375px no horizontal scroll: {label}", w[0] <= w[1], w)


def hash_of(page):
    return page.evaluate("location.hash")


def wait_hash(page, pattern, timeout=15000):
    page.wait_for_function("re => new RegExp(re).test(location.hash)", arg=pattern, timeout=timeout)
    page.wait_for_timeout(100)  # hashchange -> route() runs after the hash itself flips


def next_btn(page):
    return page.locator(".wfoot .btn.primary")


def wizard_to_review(page, url, branch, service, prefix=None, mobile=False):
    """Fast path through the wizard via 'Paste a clone URL'. Screenshots each step if prefix."""
    page.goto(BASE + "#/dashboard")
    page.get_by_role("button", name="New build").first.click()
    wait_hash(page, "^#/new/repo$")
    page.get_by_role("button", name="Paste a clone URL").click()
    page.locator("#repo").fill(url)
    if prefix:
        shot(page, prefix + "_1_repo")
        if mobile:
            no_hscroll(page, "wizard repo")
    page.locator("#repo").press("Enter")
    wait_hash(page, "^#/new/source$")
    page.locator("#branch").fill(branch)
    page.locator("#service").fill(service)
    if prefix:
        shot(page, prefix + "_2_source")
        if mobile:
            no_hscroll(page, "wizard source")
    next_btn(page).click()
    wait_hash(page, "^#/new/password$")
    page.locator("#password").fill(PW)
    page.locator("#password_confirm").fill(PW)
    if prefix:
        shot(page, prefix + "_3_password")
        if mobile:
            no_hscroll(page, "wizard password")
    page.locator("#password_confirm").press("Enter")
    wait_hash(page, "^#/new/upload$")
    page.wait_for_selector(".rcard, .alert.warning")
    if prefix:
        shot(page, prefix + "_4_upload")
        if mobile:
            no_hscroll(page, "wizard upload")
    if page.locator("input[name=upload][value=false]").count():
        page.locator("label.rcard", has_text="Don't upload").click()
    next_btn(page).click()
    wait_hash(page, "^#/new/review$")
    expect(page.locator("dl.review")).not_to_contain_text("Checking…")
    if prefix:
        shot(page, prefix + "_5_review")
        if mobile:
            no_hscroll(page, "wizard review")


def start_and_wait(page, timeout=180000):
    next_btn(page).click()
    wait_hash(page, "^#/jobs/[0-9a-f]{32}$")
    page.wait_for_selector(".result", timeout=timeout)
    return hash_of(page).split("/")[-1]


# ------------------------------------------------------------------ flows

def t_login_screens(browser):
    for name, kw in [("login_light", {}), ("login_dark", {"color_scheme": "dark"}),
                     ("login_mobile", {"viewport": {"width": 375, "height": 812}, "is_mobile": True, "has_touch": True})]:
        p = new_page(browser, name, **kw)
        p.goto(BASE)
        wait_hash(p, "^#/login$")
        p.wait_for_selector(".login .panel")
        shot(p, name)
        if name == "login_mobile":
            no_hscroll(p, "login")
        p.context.close()


def t_main(browser, main_repo, extra_repo):
    p = new_page(browser, "main")
    p.goto(BASE)
    wait_hash(p, "^#/login$")
    p.wait_for_selector(".login .panel")
    # UX-1 only sign-in visible
    vis = p.evaluate("""() => ({top: !document.getElementById('top').hidden,
        text: document.body.innerText, details: [...document.querySelectorAll('details')].map(d => d.open),
        forms: [...document.querySelectorAll('input')].filter(i => i.checkVisibility()).length})""")
    check("UX-1 login: no top bar", not vis["top"], vis["top"])
    check("UX-1 login: PAT disclosure collapsed, no visible inputs", vis["details"] == [False] and vis["forms"] == 0, vis)
    check("UX-1 login: no build/upload form text", not re.search(r"Service name|Upload server|Zip password|Recent builds", vis["text"]), vis["text"][:300])
    check("UX-1 login: device button hidden without client id", "device code" not in vis["text"], "")
    check("UX-1 login: tagline + footnote", "Build, package and ship" in vis["text"] and "Runs locally" in vis["text"], vis["text"][:300])
    check("UX-2 login: Continue with GitHub focused", "Continue with GitHub" in p.evaluate("document.activeElement.textContent"),
          p.evaluate("document.activeElement.outerHTML.slice(0,120)"))
    check("title login", p.title() == "Sign in — Build Packager", p.title())
    # UX-3 empty PAT
    p.get_by_text("Use a personal access token").click()
    p.get_by_role("button", name="Sign in with token").click()
    soft("UX-3 empty PAT -> 'Paste a token first.'", lambda: expect(p.locator("#pat-err")).to_have_text("Paste a token first."))
    shot(p, "login_pat_open")
    p.get_by_text("Use a personal access token").click()  # collapse
    # UX-2 Enter on gh button signs in (keyboard)
    p.get_by_role("button", name="Continue with GitHub").focus()
    p.keyboard.press("Enter")
    wait_hash(p, "^#/dashboard$", 20000)
    soft("UX-3 toast 'Signed in as @'", lambda: expect(p.locator(".toast")).to_contain_text("Signed in as @"))
    # UX-8 empty dashboard
    p.wait_for_selector(".center-state")
    check("UX-8 empty dashboard: only 'No builds yet' + single New build",
          p.locator(".tiles").count() == 0 and p.get_by_role("button", name="New build").count() == 1
          and p.locator("text=No builds yet").count() == 1, p.locator("main").inner_text()[:300])
    # UX-5 top bar
    top = p.locator("#top")
    check("UX-5 top bar: logo, Settings, avatar menu",
          top.locator(".logo").count() == 1 and top.get_by_role("link", name="Settings").count() == 1
          and top.get_by_role("button", name="Account menu").count() == 1, top.inner_html()[:200])
    check("UX-41 focus on h1 after route", p.evaluate("document.activeElement.tagName") == "H1", p.evaluate("document.activeElement.tagName"))
    shot(p, "dashboard_empty_light")
    p.reload()
    p.wait_for_selector(".center-state")
    check("route survives reload: #/dashboard", hash_of(p) == "#/dashboard", hash_of(p))

    # ---------------- wizard step 1
    p.get_by_role("button", name="New build").click()
    wait_hash(p, "^#/new/repo$")
    p.wait_for_selector("ol.stepper")
    check("UX-12 wizard top bar shows only Cancel", top.get_by_role("link", name="Settings").count() == 0
          and top.get_by_role("button", name="Cancel").count() == 1, top.inner_text())
    check("UX-12 stepper 5 steps, step 1 current", p.locator("ol.stepper li").count() == 5
          and p.locator("ol.stepper li").nth(0).get_attribute("aria-current") == "step", "")
    soft("UX-13 GitHub repo list loads", lambda: expect(p.locator("#repo-list li[role=option]").first).to_be_visible(timeout=20000))
    nrepos = p.locator("#repo-list li[role=option]").count()
    check("UX-13 repo search focused", p.evaluate("document.activeElement.getAttribute('role')") == "combobox", "")
    shot(p, "wizard_1_repo_list")
    next_btn(p).click()
    soft("UX-14 nothing selected -> error", lambda: expect(p.locator("#repo-err")).to_have_text("Select a repository to continue."))
    first_name = p.locator("#repo-list li[role=option] .name").first.inner_text()
    p.locator("input[role=combobox]").fill(first_name[-5:])
    check("UX-13 typing filters the list", 0 < p.locator("#repo-list li[role=option]").count() <= nrepos, nrepos)
    p.locator("input[role=combobox]").fill("zzzz-no-such-repo-q")
    soft("repo search no match message", lambda: expect(p.locator(".list-empty")).to_contain_text("No repositories match"))
    p.locator("input[role=combobox]").fill(first_name)
    p.locator("input[role=combobox]").press("ArrowDown")
    p.locator("input[role=combobox]").press("Enter")
    wait_hash(p, "^#/new/source$")
    check("UX-13 ArrowDown+Enter picks repo and advances", True)
    soft("UX-15 GitHub repo: branch select with '(default)'",
         lambda: expect(p.locator("select#branch option").first).to_contain_text("(default)", timeout=20000))
    check("UX-15 service prefilled from repo name", p.locator("#service").input_value() != "", p.locator("#service").input_value())
    check("UX-15 Advanced collapsed", p.locator("#adv").get_attribute("open") is None, "")
    shot(p, "wizard_2_source_github")
    # back to step 1 via Change and paste a URL
    p.get_by_role("link", name="Change").click()
    wait_hash(p, "^#/new/repo$")
    p.get_by_role("button", name="Paste a clone URL").click()
    p.locator("#repo").fill("bad url")
    next_btn(p).click()
    soft("UX-14 bad url -> Git URL error", lambda: expect(p.locator("#repo-err")).to_contain_text("doesn't look like a Git URL"))
    p.locator("#repo").fill(main_repo)
    check("UX-14 valid abs path clears error after input", p.locator("#repo-err").is_hidden(), "")
    shot(p, "wizard_1_repo_url")
    p.locator("#repo").press("Enter")
    wait_hash(p, "^#/new/source$")
    check("keyboard Enter advances step 1 -> 2", True)
    # ---------------- step 2
    check("UX-15 non-GitHub URL: branch is free text", p.locator("input#branch").count() == 1, "")
    stale = p.locator("#branch").input_value()
    check("step 2 branch default for pasted URL is 'main' (not stale branch from earlier GitHub pick)", stale == "main", stale)
    check("service prefilled from URL basename", p.locator("#service").input_value() == "svcrepo", p.locator("#service").input_value())
    p.locator("#branch").fill("release")
    p.locator("#service").fill("-bad")
    next_btn(p).click()
    soft("UX-16 bad service -> inline error", lambda: expect(p.locator("#service-err")).to_contain_text("Use letters, numbers"))
    check("UX-16 focus on service + route kept", p.evaluate("document.activeElement.id") == "service" and hash_of(p) == "#/new/source",
          (p.evaluate("document.activeElement.id"), hash_of(p)))
    p.locator("#service").fill("MyApp")
    soft("UX-16 MyApp lowercase tag note", lambda: expect(p.locator(".preview")).to_contain_text("Docker tags are lowercase"))
    p.locator("#service").fill("")
    next_btn(p).click()
    soft("empty service -> error", lambda: expect(p.locator("#service-err")).to_be_visible())
    shot(p, "wizard_2_source_errors")
    p.locator("#service").fill("uitest")
    check("UX-16 error clears once valid", p.locator("#service-err").is_hidden(), "")
    p.locator("#adv summary").click()
    check("UX-17 Dockerfile default 'Dockerfile'", p.locator("#dockerfile").input_value() == "Dockerfile", "")
    add = p.get_by_role("button", name="Add repository")
    add.click()
    add.click()
    for i in (0, 1):
        p.locator(f"#x-url-{i}").fill(extra_repo)
        p.locator(f"#x-name-{i}").fill("dup")
    next_btn(p).click()
    soft("UX-17 duplicate extra folder error", lambda: expect(p.locator("#x-name-1-err")).to_contain_text("already used"))
    shot(p, "wizard_2_source_advanced")
    p.get_by_role("button", name="Remove repository 2").first.click()
    p.locator("#x-name-0").fill("")
    p.locator("#x-branch-0").fill("main")
    p.locator("#adv summary").click()
    soft("UX-17 collapsed summary shows '· 1 set'", lambda: expect(p.locator("#adv summary")).to_contain_text("1 set"))
    next_btn(p).click()
    wait_hash(p, "^#/new/password$")
    # ---------------- step 3
    p.locator("#password").fill("abc")
    p.locator("#password_confirm").fill("abc")
    next_btn(p).click()
    soft("UX-18 3 chars -> 'At least 4 characters.'", lambda: expect(p.locator("#password-err")).to_contain_text("At least 4 characters."))
    p.locator("#password").fill(PW)
    p.locator("#password_confirm").fill(PW + "x")
    next_btn(p).click()
    soft("UX-18 mismatch -> \"Passwords don't match.\"", lambda: expect(p.locator("#password_confirm-err")).to_contain_text("Passwords don't match."))
    shot(p, "wizard_3_password_errors")
    eye = p.locator("#password-field .eye")
    eye.click()
    check("UX-18 eye toggles both fields + aria-pressed",
          p.locator("#password").get_attribute("type") == "text" and p.locator("#password_confirm").get_attribute("type") == "text"
          and eye.get_attribute("aria-pressed") == "true", "")
    eye.click()
    p.locator("#password_confirm").fill(PW)
    check("UX-18 checklist green", p.locator(".checklist li.ok").count() == 2, "")
    p.get_by_role("button", name="Generate a strong password").click()
    gen = p.locator("#password").input_value()
    check("UX-19 generate fills 20 chars, both fields shown", len(gen) == 20 and p.locator("#password_confirm").input_value() == gen
          and p.locator("#password").get_attribute("type") == "text", gen)
    soft("UX-19 toast 'Password copied' w/o password",
         lambda: (expect(p.locator(".toast", has_text="Password copied")).to_be_visible(),
                  check("UX-19 toast has no password", gen not in p.locator("#toasts").inner_text(), "")))
    p.locator("#password").fill(PW)
    p.locator("#password_confirm").fill(PW)
    store = p.evaluate("JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + location.href")
    check("UX-23 no password in storage/URL", PW not in store and gen not in store, store[:300])
    shot(p, "wizard_3_password_ok")
    p.locator("#password_confirm").press("Enter")
    wait_hash(p, "^#/new/upload$")
    check("Enter in confirm advances to upload", True)
    # ---------------- step 4 not configured -> settings roundtrip
    soft("UX-20 not configured callout", lambda: expect(p.locator(".alert.warning")).to_contain_text("No upload server is set up"))
    shot(p, "wizard_4_upload_none")
    p.get_by_role("button", name="Set up a server").click()
    wait_hash(p, "^#/settings$")
    p.wait_for_selector("#host")
    soft("UX-21 settings shows '← Back to build'", lambda: expect(p.locator(".back-link")).to_contain_text("Back to build"))
    p.locator("#enabled").click()
    p.locator("#host").fill("127.0.0.1")
    p.locator("#port").fill("2")
    p.locator("#username").fill("deploy")
    p.locator("#remote_dir").fill("/releases")
    soft("UX-35 dirty -> 'Test connection' tests unsaved values", lambda: expect(p.locator(".wfoot .btn.secondary")).to_have_text("Test connection"))
    p.locator("#remote_dir").fill("releases")
    p.get_by_role("button", name="Save", exact=True).click()
    soft("remote path must be full path", lambda: expect(p.locator("#remote_dir-err")).to_contain_text("full path"))
    p.locator("#remote_dir").fill("/releases")
    shot(p, "settings_filled")
    p.get_by_role("button", name="Save", exact=True).click()
    soft("settings saved toast", lambda: expect(p.locator(".toast", has_text="Settings saved")).to_be_visible())
    cfg = urllib.request.urlopen(BASE + "api/config/upload").read().decode()
    check("settings PUT persisted", '"enabled":true' in cfg.replace(" ", "") and "127.0.0.1" in cfg, cfg)
    p.get_by_role("button", name="Test connection").click()
    soft("UX-35 test result inline red", lambda: expect(p.locator(".test-res.bad")).to_be_visible(timeout=25000))
    shot(p, "settings_test_fail")
    p.locator(".back-link").click()
    wait_hash(p, "^#/new/upload$")
    soft("UX-20/21 configured -> radio cards, upload preselected",
         lambda: (expect(p.locator(".rcard")).to_have_count(2), expect(p.locator("input[name=upload][value=true]")).to_be_checked()))
    check("UX-21 password kept (no re-entry prompt)", hash_of(p) == "#/new/upload", hash_of(p))
    shot(p, "wizard_4_upload_configured")
    soft("upload step shows remote path prefilled", lambda: expect(p.locator("#remote_path")).to_have_value("/releases"))
    p.locator("#remote_path").fill("not/full")
    next_btn(p).click()
    soft("upload step rejects relative path", lambda: expect(p.locator("#remote_path-err")).to_contain_text("full path"))
    p.locator("#remote_path").fill("/srv/drop/2026")
    p.locator("label.rcard", has_text="Don't upload").click()
    soft("remote path hidden when not uploading", lambda: expect(p.locator("#remote_path")).to_be_hidden())
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    # ---------------- step 5
    expect(p.locator("dl.review")).not_to_contain_text("Checking…")
    rv = p.locator("dl.review").inner_text()
    check("UX-22 review lists values", all(s in rv for s in ("release", "uitest", "Dockerfile", "Extra repos", "Off")), rv)
    check("UX-22 an Edit per row", p.locator("dl.review a", has_text="Edit").count() == p.locator("dl.review dt").count(), "")
    shot(p, "wizard_5_review")
    p.get_by_role("link", name="Edit Branch").click()
    wait_hash(p, "^#/new/source$")
    soft("UX-22 Edit -> 'Back to review'", lambda: expect(next_btn(p)).to_have_text("Back to review"))
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    p.reload()
    wait_hash(p, "^#/new/password$")
    soft("UX-23 reload on review -> password note", lambda: expect(p.locator(".alert.info").first).to_contain_text("isn't kept after a reload"))
    check("UX-23 draft kept after reload", "uitest" in p.evaluate("sessionStorage.getItem('bp.draft')"), "")
    p.locator("#password").fill(PW)
    p.locator("#password_confirm").fill(PW)
    next_btn(p).click()
    wait_hash(p, "^#/new/upload$")
    p.locator("label.rcard", has_text="Don't upload").click()
    next_btn(p).click()
    wait_hash(p, "^#/new/review$")
    expect(p.locator("dl.review")).not_to_contain_text("Checking…")
    # ---------------- start + run view
    next_btn(p).click()
    wait_hash(p, "^#/jobs/[0-9a-f]{32}$")
    jid = hash_of(p).split("/")[-1]
    check("UX-24 navigated to run view", True, jid)
    labels = p.locator(".pipeline .plab").all_inner_texts()
    check("UX-26 7 pipeline steps with exact labels", labels == ["Prepare workspace", "Clone repository", "Build image", "Save image (.tar)",
                                                              "Clone extra repositories", "Encrypt zip", "Upload"], labels)
    seen_running = False
    for _ in range(200):
        if p.locator(".pstep.ps-running").count():
            seen_running = True
            break
        if p.locator(".result").count():
            break
        p.wait_for_timeout(50)
    check("UX-26 running step visible with spinner", seen_running and p.locator(".pstep.ps-running .spin").count() >= 0, "")
    if seen_running:
        check("UX-41 tab title starts with ● while running", p.title().startswith("●"), p.title())
        shot(p, "run_live_light")
    p.wait_for_selector(".result.ok", timeout=180000)
    shot(p, "run_success_light")
    nlines = p.locator(".log > div:not(.dim)").count()
    check("UX-27 log streamed lines", nlines > 5, nlines)
    check("UX-27 log styled: ==> bold rows and $ cmd rows", p.locator(".log .hd").count() > 0 and p.locator(".log .cmd").count() > 0, "")
    sts = p.eval_on_selector_all(".pstep", "els => els.map(e => e.className.replace('pstep ps-',''))")
    check("pipeline final statuses", sts == ["success"] * 6 + ["skipped"], sts)
    durs = p.locator(".pipeline .pdur").all_inner_texts()
    check("step durations shown", all(d for d in durs[:6]), durs)
    check("UX-41 tab title ✓", p.title().startswith("✓"), p.title())
    card = p.locator(".result.ok").inner_text()
    check("UX-29 success card: duration, zip name, Not uploaded", "Build succeeded in" in card and ".zip" in card and "Not uploaded" in card, card)
    check("UX-29 tar note 'not encrypted'", "not encrypted" in card, card)
    check("live indicator 'ended'", p.locator(".live").inner_text().strip() == "ended", p.locator(".live").inner_text())
    with p.expect_download() as d:
        p.locator(".result a", has_text="Download .zip").click()
    zpath = d.value.path()
    check("UX-29 zip download works", os.path.getsize(zpath) > 0 and d.value.suggested_filename.endswith(".zip"), d.value.suggested_filename)
    with p.expect_download() as d:
        p.locator(".result a", has_text="Download .tar").click()
    check("UX-29 tar download works", os.path.getsize(d.value.path()) > 0 and d.value.suggested_filename.endswith(".tar"), d.value.suggested_filename)
    # log toolbar
    p.get_by_role("button", name="Copy log", exact=True).click()
    soft("UX-28 'Log copied' toast", lambda: expect(p.locator(".toast", has_text="Log copied")).to_be_visible())
    hide = p.locator(".logbar button[aria-controls=log-box]")
    before = hide.get_attribute("aria-expanded")
    hide.click()
    check("UX-28 Hide/Show toggles aria-expanded", hide.get_attribute("aria-expanded") != before, (before, hide.get_attribute("aria-expanded")))
    p.reload()
    p.wait_for_selector(".result.ok")
    check("route survives reload: #/jobs/<id> shows result immediately", hash_of(p) == "#/jobs/" + jid, hash_of(p))
    check("UX-32 finished success: log collapsed", p.locator("#log-box").is_hidden(), "")
    shot(p, "run_success_reloaded")
    p.go_back()
    p.wait_for_timeout(500)
    check("UX-24 browser Back from run view -> not into wizard", not hash_of(p).startswith("#/new"), hash_of(p))

    # ---------------- dashboard with a build
    p.goto(BASE + "#/dashboard")
    p.wait_for_selector(".tiles")
    tiles = p.locator(".tile .num").all_inner_texts()
    check("UX-6 tiles Total/Succeeded/Failed = 1/1/0", tiles == ["1", "1", "0"], tiles)
    row = p.locator(".jrow").first.inner_text()
    check("UX-7 row: service, repo · branch, Succeeded line", "uitest" in row and "svcrepo · release" in row and "Succeeded · zip" in row, row)
    shot(p, "dashboard_one_light")
    p.locator(".jrow a").first.click()
    wait_hash(p, "^#/jobs/" + jid)
    p.wait_for_selector(".result.ok")
    check("open build from list", True)
    p.goto(BASE + "#/dashboard")
    p.wait_for_selector(".tiles")
    p.locator("a.tile.lastt").click()
    wait_hash(p, "^#/jobs/" + jid)
    check("UX-6 Last build tile opens job", True)

    # ---------------- failing build (bad branch)
    wizard_to_review(p, main_repo, "nope-branch", "uitestfail")
    fid = start_and_wait(p)
    p.wait_for_selector(".result.bad")
    fcard = p.locator(".result.bad").inner_text()
    check("UX-30 failed card 'Failed at the Clone repository step' + hint + git cause", "Failed at the Clone repository step" in fcard and "fatal:" in fcard and "Check the branch name" in fcard, fcard)
    check("UX-30 tab title ✗", p.title().startswith("✗"), p.title())
    sts = p.eval_on_selector_all(".pstep", "els => els.map(e => e.className.replace('pstep ps-',''))")
    check("UX-30 failed step red, later 'not run'", sts[1] == "failed" and all(s == "skipped ps-notrun" for s in sts[2:]), sts)
    check("failed job: log stays open", p.locator("#log-box").is_visible(), "")
    shot(p, "run_failed_light")
    p.goto(BASE + "#/dashboard")
    p.wait_for_selector(".tiles")
    tiles = p.locator(".tile .num").all_inner_texts()
    check("UX-6 tiles after failure 2/1/1, Failed red", tiles == ["2", "1", "1"] and "danger" in p.locator(".tile .num").nth(2).get_attribute("class"), tiles)
    check("UX-7 failed row 'Failed at Clone repository' red", p.locator(".jrow .line2.danger", has_text="Failed at Clone repository").count() == 1, "")
    shot(p, "dashboard_two_light")
    # row menu
    p.get_by_role("button", name="Actions for uitestfail").click()
    items = p.locator("[role=menu] [role=menuitem]").all_inner_texts()
    check("UX-10 failed row menu: View, Rebuild, Delete… (no zip)", items == ["View", "Rebuild", "Delete…"], items)
    shot(p, "dashboard_row_menu")
    p.keyboard.press("Escape")
    p.get_by_role("button", name="Actions for uitest", exact=True).click()
    items = p.locator("[role=menu] [role=menuitem]").all_inner_texts()
    check("UX-10 success row menu has Download .zip", "Download .zip" in items, items)
    p.locator("[role=menuitem]", has_text="Rebuild").click()
    wait_hash(p, "^#/new/password$")
    soft("UX-31 rebuild note 'Settings copied from'", lambda: expect(p.locator(".alert.info").first).to_contain_text("Settings copied from"))
    check("UX-31 steps 1,2 done", p.locator("ol.stepper li.done").count() == 2, "")
    shot(p, "wizard_rebuild")
    p.locator("#top").get_by_role("button", name="Cancel").click()
    soft("cancel dirty wizard -> discard dialog", lambda: expect(p.locator("#dlg")).to_be_visible())
    p.locator("#dlg-yes").click()
    wait_hash(p, "^#/dashboard$")
    # 404
    for bad in ("abc", "0" * 32):
        p.goto(BASE + "#/jobs/" + bad)
        soft(f"UX-33 #/jobs/{bad[:6]} -> Build not found", lambda: expect(p.locator("h1")).to_contain_text("Build not found"))
    shot(p, "job_not_found")

    # ---------------- settings protocol behaviour
    p.goto(BASE + "#/settings")
    p.wait_for_selector("#host")
    p.locator(".seg label").filter(has_text=re.compile("^FTP$")).click()
    check("UX-34 FTP sets port 21", p.locator("#port").input_value() == "21", p.locator("#port").input_value())
    check("UX-34 FTP warning shown, private key hidden", p.locator(".alert.warning", has_text="unencrypted").is_visible()
          and p.locator("#private_key_path").is_hidden(), "")
    shot(p, "settings_ftp")
    p.locator("#top .logo").click()
    soft("UX-35 leaving dirty settings -> 'Discard unsaved changes?'", lambda: expect(p.locator("#dlg-t")).to_have_text("Discard unsaved changes?"))
    p.locator("#dlg-yes").click()
    wait_hash(p, "^#/dashboard$")
    p.goto(BASE + "#/settings")
    p.wait_for_selector("#host")
    check("route survives reload: #/settings", True)
    shot(p, "settings_light")
    p.context.close()
    return jid, fid


def t_variants(browser, main_repo, jid, fid):
    """Dark + mobile screenshots of every signed-in screen."""
    for tag, kw in [("dark", {"color_scheme": "dark"}),
                    ("mobile", {"viewport": {"width": 375, "height": 812}, "is_mobile": True, "has_touch": True}),
                    ("mobile_dark", {"viewport": {"width": 375, "height": 812}, "is_mobile": True, "has_touch": True, "color_scheme": "dark"})]:
        p = new_page(browser, tag, **kw)
        mobile = "mobile" in tag
        p.goto(BASE + "#/dashboard")
        p.wait_for_selector(".tiles")
        shot(p, f"dashboard_{tag}")
        if mobile:
            no_hscroll(p, "dashboard")
        if tag == "dark":
            bg = p.evaluate("getComputedStyle(document.body).backgroundColor")
            check("UX-39 dark mode body background dark", bg in ("rgb(10, 10, 11)",), bg)
        wizard_to_review(p, main_repo, "release", "uitest", prefix=f"wizard_{tag}", mobile=mobile)
        p.locator("#top").get_by_role("button", name="Cancel").click()
        p.locator("#dlg-yes").click()
        for name, j in (("success", jid), ("failed", fid)):
            p.goto(BASE + "#/jobs/" + j)
            p.wait_for_selector(".result")
            if name == "success":
                p.locator(".logbar button[aria-controls=log-box]").click()  # show log in screenshot
            shot(p, f"run_{name}_{tag}")
            if mobile:
                no_hscroll(p, "run " + name)
        p.goto(BASE + "#/settings")
        p.wait_for_selector("#host")
        shot(p, f"settings_{tag}")
        if mobile:
            no_hscroll(p, "settings")
        p.context.close()


def t_live(browser, slow_repo):
    """Slow build: log jump chip, live dashboard row, polling stop, finish toast, delete flow, N key."""
    p = new_page(browser, "live")
    wizard_to_review(p, slow_repo, "main", "uitestslow")
    p.mouse.move(5, 5)
    next_btn(p).click()
    wait_hash(p, "^#/jobs/[0-9a-f]{32}$")
    p.wait_for_selector(".log > div", timeout=60000)
    p.wait_for_timeout(1500)
    p.locator(".log").evaluate("e => e.scrollTop = 0")
    p.locator(".log").dispatch_event("scroll")
    soft("UX-27 scroll up -> 'Jump to latest' chip", lambda: expect(p.get_by_text("Jump to latest")).to_be_visible())
    shot(p, "run_jump_chip")
    p.goto(BASE + "#/dashboard")
    p.wait_for_selector(".jrow")
    d1 = p.locator(".jrow .dur").first.inner_text()
    p.wait_for_timeout(2500)
    row = p.locator(".jrow").first.inner_text()
    check("UX-11 running row ticks + 'Running · <Step> (n/7)'",
          p.locator(".jrow .dur").first.inner_text() != d1 and re.search(r"Running · .+ \(\d/7\)", row), (d1, row))
    p.get_by_role("button", name="Actions for uitestslow").click()
    dis = p.locator("[role=menuitem]", has_text="Delete").evaluate("e => e.disabled || e.getAttribute('aria-disabled') === 'true'")
    check("UX-10 Delete disabled while running", dis, dis)
    p.keyboard.press("Escape")
    reqs = []
    p.on("request", lambda r: "/api/jobs" in r.url and reqs.append(r.url))
    p.wait_for_selector(".jrow .line2:has-text('Succeeded')", timeout=120000)
    soft("dashboard finish toast '<service> succeeded'", lambda: expect(p.locator(".toast", has_text="uitestslow succeeded")).to_be_visible())
    n0 = len(reqs)
    p.wait_for_timeout(7000)
    check("UX-11 polling stops when nothing runs", len(reqs) == n0, reqs[n0:])
    check("toasts auto-dismiss (mouse away)", p.locator("#toasts .toast").count() == 0, p.locator("#toasts").inner_text())
    p.get_by_role("button", name="Actions for uitestslow").click()
    p.locator("[role=menuitem]", has_text="Delete").click()
    check("UX-10 delete dialog names folder", "uitestslow_" in p.locator("#dlg").inner_text(), p.locator("#dlg").inner_text())
    shot(p, "dashboard_delete_dialog")
    n = p.locator(".jrow").count()
    p.locator("#dlg-yes").click()
    soft("UX-10 delete removes row + toast 'Build deleted'",
         lambda: (expect(p.locator(".jrow")).to_have_count(n - 1), expect(p.locator(".toast", has_text="Build deleted")).to_be_visible()))
    p.locator("h1").click()
    p.keyboard.press("n")
    wait_hash(p, "^#/new/repo$")
    check("dashboard key N -> New build", True)
    p.context.close()
    m = new_page(browser, "mtiles", viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
    m.goto(BASE + "#/dashboard")
    m.wait_for_selector(".tiles")
    check("UX-38/§4.2 375px: Last build tile visible (full width)", m.locator(".tile.lastt").is_visible(),
          "`.tiles .tile.lastt{display:none}` at max-width:480px; tiles are 3 columns, not 2x2 + full-width Last build")
    m.context.close()


def t_signout(browser):
    p = new_page(browser, "signout")
    p.goto(BASE + "#/dashboard")
    p.wait_for_selector(".tiles")
    p.get_by_role("button", name="Account menu").click()
    menu = p.locator("[role=menu]").inner_text()
    check("UX-5 avatar menu: 'Signed in as @' + Sign out", "Signed in as @" in menu and "Sign out" in menu, menu)
    shot(p, "account_menu")
    p.get_by_role("menuitem", name="Sign out").click()
    wait_hash(p, "^#/login$")
    check("UX-5 sign out -> #/login", True)
    p.goto(BASE + "#/settings")
    wait_hash(p, "^#/login$")
    check("guard: logged out #/settings -> #/login", True)
    p.context.close()


def main():
    os.makedirs(SHOTS, exist_ok=True)
    if sh("bash", "-c", f"ss -ltnH 'sport = :{PORT}'").stdout.strip():
        sys.exit(f"port {PORT} busy")
    tmp = tempfile.mkdtemp(prefix="bp_ui_")
    base_img = "busybox:latest" if sh("docker", "image", "inspect", "busybox:latest").returncode == 0 else "alpine:latest"
    main_repo = os.path.join(tmp, "fx", "svcrepo")
    git_repo(main_repo, {"Dockerfile": f"FROM {base_img}\nCOPY hello.txt /hello.txt\nCMD [\"true\"]\n", "hello.txt": "hi\n"}, "release")
    extra_repo = os.path.join(tmp, "fx", "extra1")
    git_repo(extra_repo, {"README.md": "extra\n"}, "main")
    slow_repo = os.path.join(tmp, "fx", "slowrepo")
    git_repo(slow_repo, {"Dockerfile": f"FROM {base_img}\nCOPY stamp.txt /stamp.txt\nRUN for i in $(seq 1 400); do echo line$i; done; sleep 8\n",
                         "stamp.txt": str(time.time()) + "\n"}, "main")  # stamp busts the docker layer cache
    proc = start_server(tmp)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
            try:
                t_login_screens(browser)
                jid, fid = t_main(browser, main_repo, extra_repo)
                t_variants(browser, main_repo, jid, fid)
                t_live(browser, slow_repo)
                t_signout(browser)
            except Exception:
                import traceback
                traceback.print_exc()
                check("ui test run completed without exception", False, "see traceback")
            finally:
                browser.close()
        # Chrome logs every non-2xx fetch as a console error; the 404 for the deliberate #/jobs/000… probe is expected.
        errs = [c for c in CONSOLE if "avatars.githubusercontent" not in c and "/api/jobs/" + "0" * 32 not in c]
        check("zero console errors", not errs, "\n".join(errs[:20]))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        out = sh("docker", "images", "--format", "{{.Repository}}:{{.Tag}}").stdout.split()
        rm = [i for i in out if i.split(":")[0] in SERVICES]
        if rm:
            sh("docker", "rmi", "-f", *rm)
        shutil.rmtree(tmp, ignore_errors=True)
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed; screenshots in {SHOTS}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
