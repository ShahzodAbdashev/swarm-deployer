"""GitLab REST client: reads a project's CI/CD variables for "Import from GitLab project"."""
import json
import os
import urllib.request

from backend.config.store import load_config
from backend.core.errors import bad


def gl_base(cfg):
    return (cfg["gitlab"]["url"] or os.environ.get("GITLAB_URL") or "http://192.168.33.175").rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # a 3xx is an error: urllib would copy the Bearer header to any host
        return None


GL_OPENER = urllib.request.build_opener(NoRedirect)


def gl_get(path):
    """(status, json or None) for GET <gitlab>/<path> with the saved token. The token never reaches a message."""
    cfg = load_config()
    tok = cfg["gitlab"]["token"]
    if not tok:
        bad("GitLab token not set: add one in Settings → GitLab")
    req = urllib.request.Request(gl_base(cfg) + path, headers={"Accept": "application/json",
                                                               "Authorization": f"Bearer {tok}"})
    try:
        with GL_OPENER.open(req, timeout=15) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        bad(f"GitLab unreachable: {getattr(e, 'reason', None) or type(e).__name__}", 502)
    if status == 401:
        bad("GitLab rejected the token", 401)
    try:
        return status, json.loads(body)
    except ValueError:
        return status, None


def gl_paths(project):
    return urllib.parse.quote(project, safe="")


def gl_ci_vars(project):
    """Project variables, then nearest group .. root group (first hit wins, scope * preferred). None = hidden."""
    pid = gl_paths(project)
    st, p = gl_get(f"/api/v4/projects/{pid}")
    if st == 404:
        bad(f"GitLab: project {project} not found", 404)
    if st != 200 or not isinstance(p, dict):
        bad(f"GitLab error {st}", 502)
    st, pv = gl_get(f"/api/v4/projects/{pid}/variables?per_page=100")
    if st == 403:
        bad("GitLab: variables need the api scope and Maintainer role", 403)
    if st != 200:
        bad(f"GitLab error {st}", 502)
    tables = [pv]
    ns = p.get("namespace") or {}
    if ns.get("kind") == "group" and ns.get("full_path"):
        parts = ns["full_path"].split("/")
        for i in range(len(parts), 0, -1):
            st, gv = gl_get(f"/api/v4/groups/{gl_paths('/'.join(parts[:i]))}/variables?per_page=100")
            if st == 200:
                tables.append(gv)  # 403/404 on a group: skipped
    out = {}
    for tbl in tables:
        best = {}
        for v in tbl if isinstance(tbl, list) else []:
            k = isinstance(v, dict) and v.get("key")
            if k and (k not in best or (v.get("environment_scope") == "*" and best[k].get("environment_scope") != "*")):
                best[k] = v
        for k, v in best.items():
            out.setdefault(k, v.get("value"))  # variable_type file: the value is the content
    prefix = p.get("container_registry_image_prefix")
    if "CI_REGISTRY_IMAGE" not in out and prefix:  # predefined CI variables are not in the variables API
        out["CI_REGISTRY_IMAGE"] = prefix
        out.setdefault("CI_REGISTRY", prefix.split("/")[0])
    return out
