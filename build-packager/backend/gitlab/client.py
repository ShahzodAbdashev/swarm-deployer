"""GitLab API client and token refresh."""
import os
import threading
import time
from urllib.parse import quote

import httpx

from backend.config.store import load_config, update_config
from backend.core.constants import GL_DEFAULT
from backend.core.errors import bad
from backend.core.patterns import GL_URL_RE


gl_lock = threading.Lock()


def gl_base(cfg=None):
    cfg = cfg or load_config()
    return (cfg.get("gitlab_url") or os.environ.get("GITLAB_URL") or GL_DEFAULT).rstrip("/")


def gl_client(cfg):
    return (cfg.get("gitlab_client_id") or os.environ.get("GITLAB_CLIENT_ID") or "",
            cfg.get("gitlab_client_secret") or os.environ.get("GITLAB_CLIENT_SECRET") or "")


def gl_signed_in(cfg):
    return bool(cfg.get("gitlab_token")) and cfg.get("gitlab_token_url") == gl_base(cfg)


def gl_clean_url(u):
    u = (u or "").strip().rstrip("/")
    if len(u) > 200 or not GL_URL_RE.match(u):
        bad("url: must be http(s)://host[:port][/path]")
    return u


def gl_clear(c):
    c.update(gitlab_token=None, gitlab_token_url="", gitlab_refresh_token=None, gitlab_expires_at=None,
             gitlab_login=None, gitlab_avatar_url=None, gitlab_method=None)


def gl_request(method, path, token=None, data=None, base=None, timeout=15):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        return httpx.request(method, (base or gl_base()) + path, headers=headers, data=data, timeout=timeout)
    except httpx.HTTPError as e:
        bad(f"GitLab unreachable: {e}", 502)


def rjson(r):
    try:
        return r.json()
    except ValueError:
        return None


def need_gitlab():
    """A usable GitLab access token (refreshed when it expires within 60 s) or 401."""
    cfg = load_config()
    if not gl_signed_in(cfg):
        bad("not signed in to GitLab", 401)
    if not (cfg["gitlab_expires_at"] and cfg["gitlab_refresh_token"] and time.time() > cfg["gitlab_expires_at"] - 60):
        return cfg["gitlab_token"]
    with gl_lock:
        cfg = load_config()  # another request may have refreshed already
        if not gl_signed_in(cfg):
            bad("not signed in to GitLab", 401)
        if not (cfg["gitlab_expires_at"] and time.time() > cfg["gitlab_expires_at"] - 60):
            return cfg["gitlab_token"]
        cid, csec = gl_client(cfg)
        form = {"grant_type": "refresh_token", "refresh_token": cfg["gitlab_refresh_token"], "client_id": cid,
                "redirect_uri": cfg["gitlab_redirect_uri"]}
        if csec:
            form["client_secret"] = csec
        r = gl_request("POST", "/oauth/token", data=form)
        d = rjson(r) or {}
        if r.status_code in (400, 401):
            update_config(gl_clear)
            bad("GitLab session expired, sign in again", 401)
        if r.status_code != 200 or not d.get("access_token"):
            bad(f"GitLab error {r.status_code}", 502)
        update_config(lambda c: c.update(
            gitlab_token=d["access_token"], gitlab_refresh_token=d.get("refresh_token") or c["gitlab_refresh_token"],
            gitlab_expires_at=int(time.time()) + int(d.get("expires_in") or 7200)))
        return d["access_token"]


def gl_api(path, token):
    """GET a GitLab API path. 401 -> 401; returns (status, json)."""
    r = gl_request("GET", "/api/v4" + path, token)
    if r.status_code == 401:
        bad("GitLab returned 401", 401)
    return r.status_code, rjson(r)


def gl_q(project):
    return quote(project, safe="")


def gl_level(variables):
    """GitLab variables list -> {key: {value, raw, file}}; environment_scope '*' beats scoped values."""
    out = {}
    for v in variables or []:
        k = v.get("key")
        if not k or (k in out and out[k]["scope"] == "*"):
            continue
        if k in out and v.get("environment_scope", "*") != "*":
            continue
        out[k] = {"value": v.get("value"), "raw": bool(v.get("raw")), "file": v.get("variable_type") == "file",
                  "scope": v.get("environment_scope", "*")}
    return out
