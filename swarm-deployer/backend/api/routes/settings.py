"""Settings: GitLab (for project import), file server, options."""
from fastapi import APIRouter, Body

from backend.api.deps import obj
from backend.config.store import load_config, public, update_config
from backend.core.constants import DEFAULTS, OPTION_RULES
from backend.core.errors import bad
from backend.gitlab.client import gl_base, gl_get
from backend.remote.fileserver import fileserver
from backend.utils.images import parse_pkg
from backend.validators.fields import v_bool, v_gl_url, v_int, v_str
from backend.validators.settings import check_file_server, drop_moved_pw

router = APIRouter()


@router.get("/api/config")
def get_config():
    cfg = load_config()
    out = public(cfg)
    out["gitlab"]["url"] = gl_base(cfg)
    return out


@router.put("/api/config/gitlab")
def put_gitlab(body: dict = Body(default={})):
    body = obj(body)

    def apply(cfg):
        g = cfg["gitlab"]
        if body.get("url") not in (None, ""):
            url = v_gl_url(body["url"])
            if url != gl_base(cfg) and "token" not in body:
                g["token"] = ""  # a saved token belongs to its GitLab: never send it to a new one
            g["url"] = url
        if "token" in body:
            g["token"] = v_str(body["token"], "token", 1024).strip()
        return {**public(g), "url": gl_base(cfg)}
    return update_config(apply)


@router.get("/api/gitlab/projects")
def gitlab_projects():
    st, js = gl_get("/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at")
    if st != 200 or not isinstance(js, list):
        bad(f"GitLab error {st}", 502)
    base = gl_base(load_config())  # never http_url_to_repo: GitLab builds it from its external_url
    return [{"full_name": p["path_with_namespace"], "clone_url": f"{base}/{p['path_with_namespace']}.git",
             "default_branch": p.get("default_branch"), "private": p.get("visibility") != "public"}
            for p in js if isinstance(p, dict) and p.get("path_with_namespace")]


@router.put("/api/config/file-server")
def put_file_server(body: dict = Body(default={})):
    def apply(cfg):
        fs = {**cfg["file_server"], **{k: v for k, v in obj(body).items() if k in DEFAULTS["file_server"]}}
        drop_moved_pw(fs, cfg["file_server"], obj(body))
        cfg["file_server"] = check_file_server(fs)
        return public(fs)
    return update_config(apply)


@router.post("/api/config/file-server/test")
def test_file_server(body: dict | None = Body(default=None)):
    over = {k: v for k, v in obj(body).items() if k in DEFAULTS["file_server"]}
    if not over.get("password"):
        over.pop("password", None)
    fs0 = load_config()["file_server"]
    fs = {**fs0, **over}
    drop_moved_pw(fs, fs0, over)
    fs = check_file_server(fs)
    if not fs["host"] and fs.get("protocol") != "local":
        bad("host: required")
    try:
        with fileserver(fs) as (ls, _get):
            n = sum(1 for name, is_dir, *_ in ls(fs["remote_dir"]) if not is_dir and parse_pkg(name))
        where = "Local folder:" if fs.get("protocol") == "local" else f"Connected to {fs['host']}:{fs['port']},"
        return {"ok": True, "message": f"{where} {n} packages in {fs['remote_dir']}"}
    except Exception as e:
        return {"ok": False, "message": f"{type(e).__name__}: {e}"}


@router.put("/api/config/options")
def put_options(body: dict = Body(default={})):
    def apply(cfg):
        for k, v in obj(body).items():
            if k in ("save_image_tar", "prune_after"):
                cfg["options"][k] = v_bool(v, k)
            elif k in OPTION_RULES:
                cfg["options"][k] = v_int(v, k, *OPTION_RULES[k])
        return cfg["options"]
    return update_config(apply)
