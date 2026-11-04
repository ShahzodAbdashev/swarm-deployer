""".env and GitLab CI/CD variable import."""
from fastapi import APIRouter, Body

from backend.api.deps import obj
from backend.core.errors import bad
from backend.core.patterns import GL_PROJECT_RE, TID_RE
from backend.envimport.apply import apply_env
from backend.envimport.parser import parse_env
from backend.gitlab.client import gl_ci_vars
from backend.validators.fields import v_re

router = APIRouter()


@router.post("/api/config/import-env")
def import_env(body: dict = Body(default={})):
    body = obj(body)
    content = body.get("content")
    if not isinstance(content, str) or not 1 <= len(content) <= 262144:
        bad("content: required, 1-262144 characters")
    kv = parse_env(content)
    if not kv:
        bad("content: no KEY=value lines")
    tid = body.get("target_id") or None
    if tid is not None:
        v_re(tid, "target_id", TID_RE)
    return apply_env(kv, target_id=tid)


@router.post("/api/config/import-gitlab")
def import_gitlab(body: dict = Body(default={})):
    body = obj(body)
    project = v_re(body.get("project"), "project", GL_PROJECT_RE, "a GitLab project path like group/app")
    if ".." in project.split("/"):
        bad("project: invalid path")
    tid = body.get("target_id") or None
    if tid is not None:
        v_re(tid, "target_id", TID_RE)
    return {**apply_env(gl_ci_vars(project), tid, project, source="gitlab"), "project": project}
