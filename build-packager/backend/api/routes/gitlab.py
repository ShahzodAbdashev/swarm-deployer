"""GitLab settings, projects, branches and the .env preview."""
from urllib.parse import quote, urlsplit

from fastapi import APIRouter

from backend.api.schemas import EnvPreviewIn, GitlabCfgIn
from backend.config.store import load_config, update_config
from backend.core.errors import bad
from backend.envfile.gitlab_ci import parse_ci_env, render_env
from backend.gitlab.client import gl_api, gl_base, gl_client, gl_level, gl_q, gl_request, need_gitlab
from backend.validators.fields import valid_branch, valid_project

router = APIRouter()


def gitlab_cfg_out(c):
    cid = gl_client(c)[0]
    return {"url": gl_base(c), "client_id": cid,
            "client_id_source": "settings" if c["gitlab_client_id"] else "env" if cid else None,
            "has_client_secret": bool(gl_client(c)[1]), "oauth_available": bool(cid)}


@router.get("/api/config/gitlab")
def get_gitlab_cfg():
    return gitlab_cfg_out(load_config())


@router.put("/api/config/gitlab")
def put_gitlab_cfg(body: GitlabCfgIn):
    for name, v, n in (("client_id", body.client_id, 200), ("client_secret", body.client_secret, 512)):
        if v is not None and (len(v) > n or any(ord(ch) < 32 for ch in v)):
            bad(f"{name}: at most {n} characters, no control characters")
    upd = {"gitlab_" + k: v.strip() for k, v in body.model_dump(exclude_none=True).items()}
    return gitlab_cfg_out(update_config(lambda c: c.update(upd)))


@router.get("/api/gitlab/projects")
def gitlab_projects():
    c = load_config()
    st, data = gl_api("/projects?membership=true&per_page=100&order_by=last_activity_at", need_gitlab())
    if st != 200 or not isinstance(data, list):
        bad(f"GitLab error {st}", 502)
    base = gl_base(c)  # ponytail: first page only (100 projects)
    return [{"full_name": p.get("path_with_namespace"), "clone_url": f"{base}/{p.get('path_with_namespace')}.git",
             "default_branch": p.get("default_branch"), "private": p.get("visibility") != "public"} for p in data]


@router.get("/api/gitlab/branches")
def gitlab_branches(project: str = ""):
    if not valid_project(project):
        bad("project: must be group/name")
    st, data = gl_api(f"/projects/{gl_q(project)}/repository/branches?per_page=100", need_gitlab())
    if st == 404:
        bad("GitLab returned 404", 404)
    if st != 200 or not isinstance(data, list):
        bad(f"GitLab error {st}", 502)
    return [{"name": b["name"]} for b in data]


@router.post("/api/gitlab/env-preview")
def gitlab_env_preview(body: EnvPreviewIn):
    token = need_gitlab()
    base = gl_base()
    u, b = urlsplit(body.repo_url or ""), urlsplit(base)
    path = u.path
    if b.path and path.startswith(b.path + "/"):
        path = path[len(b.path):]
    project = path.strip("/").removesuffix(".git")
    if (u.scheme, u.netloc.lower()) != (b.scheme, b.netloc.lower()) or not valid_project(project):
        bad(f"repo_url: not a project on {base}")
    if not valid_branch(body.branch):
        bad("branch: invalid branch name")
    job = body.job or "export_env"
    if len(job) > 255 or any(ord(ch) < 32 for ch in job):
        bad("job: 1-255 characters, no control characters")
    q = gl_q(project)
    pst, proj = gl_api(f"/projects/{q}", token)
    if pst == 404:
        bad("GitLab returned 404", 404)
    proj = proj if pst == 200 and isinstance(proj, dict) else {}
    r = gl_request("GET", f"/api/v4/projects/{q}/repository/files/.gitlab-ci.yml/raw?ref={quote(body.branch, safe='')}", token)
    if r.status_code == 401:
        bad("GitLab returned 401", 401)
    if r.status_code == 404:
        bad(f".gitlab-ci.yml not found on {body.branch}")
    if r.status_code != 200:
        bad(f"GitLab error {r.status_code}", 502)
    if len(r.content) > 512 * 1024:
        bad(".gitlab-ci.yml: larger than 512 KB")
    parsed = parse_ci_env(r.text, job)
    levels, warns = [], []
    vst, pv = gl_api(f"/projects/{q}/variables?per_page=100", token)
    if vst == 200 and isinstance(pv, list):
        levels.append(("project", gl_level(pv)))
    else:
        warns.append(f"project {project}: variables not readable ({vst})")
    ns = proj.get("namespace") or {}
    if ns.get("kind") == "group" and ns.get("full_path"):
        parts = ns["full_path"].split("/")
        for i in range(len(parts), 0, -1):
            g = "/".join(parts[:i])
            gst, gv = gl_api(f"/groups/{gl_q(g)}/variables?per_page=100", token)
            if gst == 200 and isinstance(gv, list):
                levels.append((f"group {g}", gl_level(gv)))
            else:
                warns.append(f"group {g}: variables not readable ({gst})")
    levels += [("job variables", parsed["job_vars"]), ("variables", parsed["top_vars"]),
               ("predefined", predefined_vars(project, body.branch, proj))]
    parsed["warnings"] = warns + parsed["warnings"]
    return {"project": project, "branch": body.branch, "job": parsed["job"], "target": parsed["target"],
            **render_env(parsed, levels)}


def predefined_vars(project, branch, proj):
    v = {"CI_PROJECT_NAME": proj.get("path") or project.rsplit("/", 1)[-1], "CI_PROJECT_PATH": project,
         "CI_PROJECT_NAMESPACE": project.rsplit("/", 1)[0], "CI_PROJECT_DIR": "/builds/" + project,
         "CI_COMMIT_REF_NAME": branch, "CI_COMMIT_BRANCH": branch,
         "CI_DEFAULT_BRANCH": proj.get("default_branch") or "main"}
    if proj.get("container_registry_image_prefix"):
        v["CI_REGISTRY_IMAGE"] = proj["container_registry_image_prefix"]
    return {k: {"value": val, "raw": True} for k, val in v.items()}
