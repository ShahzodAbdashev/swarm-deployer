"""GitHub repos and branches."""
from fastapi import APIRouter

from backend.core.errors import bad
from backend.core.patterns import REPO_RE
from backend.github.client import gh_get, need_token

router = APIRouter()


@router.get("/api/github/repos")
def gh_repos():
    data = gh_get("/user/repos?per_page=100&sort=updated", need_token())
    return [{k: r.get(k) for k in ("full_name", "clone_url", "default_branch", "private")} for r in data]


@router.get("/api/github/branches")
def gh_branches(repo: str = ""):
    if not REPO_RE.match(repo) or ".." in repo:
        bad("repo: must be owner/repo")
    token = need_token()
    return [{"name": b["name"]} for b in gh_get(f"/repos/{repo}/branches?per_page=100", token)]
