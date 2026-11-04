"""GitHub API client and token storage."""
from urllib.parse import urlsplit

import httpx

from backend.config.store import load_config, update_config
from backend.core.constants import GH_API
from backend.core.errors import bad


def auth_url(url, token, gl=None):
    """GitHub token for https://github.com/...; GitLab token (gl = (base, token)) only for URLs on that exact
    scheme+host and without userinfo (D2)."""
    if gl and gl[1]:
        u, b = urlsplit(url), urlsplit(gl[0])
        if u.scheme.lower() == b.scheme.lower() and u.netloc.lower() == b.netloc.lower() and "@" not in u.netloc:
            return u.scheme + "://oauth2:" + gl[1] + "@" + url.split("://", 1)[1]
    if token and url.startswith("https://github.com/"):
        return "https://x-access-token:" + token + "@github.com/" + url[len("https://github.com/"):]
    return url


def gh_request(method, url, token=None, **kw):
    headers = {"Accept": "application/vnd.github+json" if token else "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        return httpx.request(method, url, headers=headers, timeout=15, **kw)
    except httpx.HTTPError as e:
        bad(f"GitHub unreachable: {e}", 502)


def save_token(token):
    token = (token or "").strip()
    if not token:
        bad("token: required")
    r = gh_request("GET", GH_API + "/user", token)
    if r.status_code == 401:
        bad("GitHub rejected the token", 401)
    if r.status_code != 200:
        bad(f"GitHub error {r.status_code}", 502)
    u = r.json()

    def apply(cfg):
        cfg.update(github_token=token, github_login=u.get("login"), github_avatar_url=u.get("avatar_url"))
    update_config(apply)
    return {"logged_in": True, "login": u.get("login"), "avatar_url": u.get("avatar_url")}


def need_token():
    t = load_config()["github_token"]
    if not t:
        bad("not signed in to GitHub", 401)
    return t


def gh_get(path, token):
    r = gh_request("GET", GH_API + path, token)
    if r.status_code in (401, 404):
        bad(f"GitHub returned {r.status_code}", r.status_code)
    if r.status_code != 200:
        bad(f"GitHub error {r.status_code}", 502)
    return r.json()
