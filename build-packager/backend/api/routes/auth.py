"""Sign-in: GitLab (OAuth PKCE, token), GitHub (token, gh CLI, device flow)."""
import base64
import hashlib
import os
import secrets
import subprocess
import threading
import time
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from backend.api.schemas import DeviceIn, GitlabTokenIn, TokenIn
from backend.config.store import load_config, update_config
from backend.core.enums import GitlabMethod
from backend.core.errors import bad
from backend.github.client import gh_request, save_token
from backend.gitlab.client import gl_base, gl_clean_url, gl_clear, gl_client, gl_request, gl_signed_in, rjson

router = APIRouter()


OAUTH_PENDING = {}  # state -> {verifier, redirect_uri, exp}


oauth_lock = threading.Lock()  # sync routes run in a threadpool


oauth_error = None  # one-shot, shown once by /api/auth/status


gl_user_thread = False


def gl_fill_login():
    """Background: fill the GitLab login for a token imported from .env (status never waits for GitLab)."""
    try:
        c = load_config()
        tok = c["gitlab_token"]
        r = gl_request("GET", "/api/v4/user", tok, timeout=5)
        if r.status_code == 200:
            u = rjson(r) or {}
            update_config(lambda c: c["gitlab_token"] == tok and c.update(
                gitlab_login=u.get("username"), gitlab_avatar_url=u.get("avatar_url")))
    except Exception:
        pass


@router.get("/api/auth/status")
def auth_status():
    global oauth_error, gl_user_thread
    c = load_config()
    gl_in = gl_signed_in(c)
    if gl_in and not c["gitlab_login"] and not gl_user_thread:
        gl_user_thread = True
        threading.Thread(target=gl_fill_login, daemon=True).start()
    err, oauth_error = oauth_error, None
    provider = "gitlab" if gl_in else "github" if c["github_token"] else None
    return {"logged_in": gl_in or bool(c["github_token"]),
            "login": c["gitlab_login"] if gl_in else c["github_login"],
            "avatar_url": c["gitlab_avatar_url"] if gl_in else c["github_avatar_url"],
            "device_flow_available": bool(os.environ.get("GITHUB_CLIENT_ID")),
            "provider": provider,
            "github": {"logged_in": bool(c["github_token"]), "login": c["github_login"]},
            "gitlab": {"logged_in": gl_in, "login": c["gitlab_login"] if gl_in else None,
                       "avatar_url": c["gitlab_avatar_url"] if gl_in else None, "url": gl_base(c),
                       "method": c["gitlab_method"] if gl_in else None, "oauth_available": bool(gl_client(c)[0])},
            "oauth_error": err}


@router.post("/api/auth/gitlab/token")
def gitlab_token(body: GitlabTokenIn):
    token = (body.token or "").strip()
    if not token:
        bad("token: required")
    c = load_config()
    url = gl_clean_url(body.url) if body.url else None
    if url and gl_signed_in(c) and url != gl_base(c):
        bad("sign out first to change the GitLab URL", 409)
    r = gl_request("GET", "/api/v4/user", token, base=url or gl_base(c))
    if r.status_code == 401:
        bad("GitLab rejected the token", 401)
    if r.status_code != 200:
        bad(f"GitLab error {r.status_code}", 502)
    u = rjson(r) or {}

    def apply(c):
        if url:
            c["gitlab_url"] = url
        gl_clear(c)
        c.update(gitlab_token=token, gitlab_token_url=gl_base(c), gitlab_method=GitlabMethod.PAT,
                 gitlab_login=u.get("username"), gitlab_avatar_url=u.get("avatar_url"))
    update_config(apply)
    return {"logged_in": True, "login": u.get("username"), "avatar_url": u.get("avatar_url"), "provider": "gitlab"}


def callback_uri(request):
    """This app's callback on its own origin; localhost -> 127.0.0.1 (GitLab matches the registered URI exactly)."""
    b = urlsplit(str(request.base_url))
    netloc = "127.0.0.1" + (f":{b.port}" if b.port else "") if b.hostname == "localhost" else b.netloc
    return f"{b.scheme}://{netloc}{b.path.rstrip('/')}/api/auth/gitlab/callback"


@router.get("/api/auth/gitlab/start")
def gitlab_start(request: Request):
    global oauth_error
    c = load_config()
    cid = gl_client(c)[0]
    if not cid:
        oauth_error = "GitLab sign-in isn't configured: set GITLAB_CLIENT_ID (Settings, .env or environment)"
        return RedirectResponse("/#/login", 302)
    now = time.monotonic()
    state, verifier, redirect_uri = secrets.token_urlsafe(24), secrets.token_urlsafe(48), callback_uri(request)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with oauth_lock:
        for k in [k for k, v in OAUTH_PENDING.items() if v["exp"] < now]:
            del OAUTH_PENDING[k]
        while len(OAUTH_PENDING) >= 20:
            del OAUTH_PENDING[next(iter(OAUTH_PENDING))]
        OAUTH_PENDING[state] = {"verifier": verifier, "redirect_uri": redirect_uri, "exp": now + 600}
    q = urlencode({"client_id": cid, "redirect_uri": redirect_uri, "response_type": "code", "state": state,
                   "scope": "api", "code_challenge": challenge, "code_challenge_method": "S256"})
    return RedirectResponse(f"{gl_base(c)}/oauth/authorize?{q}", 302)


@router.get("/api/auth/gitlab/callback")
def gitlab_callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    global oauth_error
    try:
        with oauth_lock:
            p = OAUTH_PENDING.pop(state, None)
        if not p or p["exp"] < time.monotonic():
            raise ValueError("sign-in expired or state mismatch, try again")
        if error:
            raise ValueError(f"GitLab: {error_description or error}")
        c = load_config()
        cid, csec = gl_client(c)
        form = {"grant_type": "authorization_code", "code": code, "redirect_uri": p["redirect_uri"],
                "client_id": cid, "code_verifier": p["verifier"]}
        if csec:
            form["client_secret"] = csec
        r = gl_request("POST", "/oauth/token", data=form)
        d = rjson(r) or {}
        if r.status_code != 200 or not d.get("access_token"):
            raise ValueError(f"GitLab token exchange failed ({r.status_code} {d.get('error') or ''})".replace(" )", ")"))
        ur = gl_request("GET", "/api/v4/user", d["access_token"])
        if ur.status_code != 200:
            raise ValueError(f"GitLab error {ur.status_code} reading the user")
        u = rjson(ur) or {}
        exp = int(time.time()) + int(d["expires_in"]) if d.get("expires_in") else None

        def apply(c):
            gl_clear(c)
            c.update(gitlab_token=d["access_token"], gitlab_token_url=gl_base(c),
                     gitlab_refresh_token=d.get("refresh_token"), gitlab_expires_at=exp, gitlab_method=GitlabMethod.OAUTH,
                     gitlab_redirect_uri=p["redirect_uri"], gitlab_login=u.get("username"),
                     gitlab_avatar_url=u.get("avatar_url"))
        update_config(apply)
        return RedirectResponse("/#/dashboard", 302)
    except (ValueError, HTTPException) as e:
        oauth_error = str(e.detail if isinstance(e, HTTPException) else e)
        return RedirectResponse("/#/login", 302)


@router.post("/api/auth/token")
def auth_token(body: TokenIn):
    return save_token(body.token)


@router.post("/api/auth/gh-cli")
def auth_gh_cli():
    try:
        p = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        p = None
    if not p or p.returncode != 0 or not p.stdout.strip():
        bad("gh CLI not available or not logged in")
    return save_token(p.stdout.strip())


def client_id():
    cid = os.environ.get("GITHUB_CLIENT_ID")
    if not cid:
        bad("device flow not available: GITHUB_CLIENT_ID is not set")
    return cid


@router.post("/api/auth/device/start")
def device_start():
    r = gh_request("POST", "https://github.com/login/device/code", data={"client_id": client_id(), "scope": "repo"})
    d = r.json() if r.status_code == 200 else {}
    if "device_code" not in d:
        bad(f"GitHub device flow failed: {d.get('error') or r.status_code}", 502)
    return {k: d.get(k) for k in ("device_code", "user_code", "verification_uri", "interval", "expires_in")}


@router.post("/api/auth/device/poll")
def device_poll(body: DeviceIn):
    r = gh_request("POST", "https://github.com/login/oauth/access_token", data={
        "client_id": client_id(), "device_code": body.device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
    try:
        d = r.json()
    except ValueError:
        bad(f"GitHub error {r.status_code}", 502)
    if d.get("access_token"):
        return {"status": "ok", **{k: v for k, v in save_token(d["access_token"]).items() if k != "logged_in"}}
    err = d.get("error") or "unknown_error"
    if err == "authorization_pending":
        return {"status": "pending"}
    if err == "slow_down":
        return {"status": "slow_down", "interval": d.get("interval", 10)}
    return {"status": "error", "error": err}


@router.post("/api/auth/logout")
def auth_logout():
    def apply(c):
        c.update(github_token=None, github_login=None, github_avatar_url=None)
        gl_clear(c)
    update_config(apply)
    return {"logged_in": False}
