"""Serves the static UI in frontend/ (plain HTML, CSS and JS modules; no build step)."""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.core.paths import UI

router = APIRouter()
NO_CACHE = {"Cache-Control": "no-cache"}  # always revalidate: edits to the UI show up on the next reload


@router.get("/")
def index():
    return FileResponse(os.path.join(UI, "index.html"), media_type="text/html", headers=NO_CACHE)


@router.get("/{path:path}")
def static_file(path: str):
    """Any file inside frontend/ (no dotfiles, no traversal). Registered last so it never shadows the API."""
    full = os.path.realpath(os.path.join(UI, path))
    if (path.startswith("api/") or not full.startswith(UI + os.sep) or not os.path.isfile(full)
            or any(p.startswith(".") for p in path.split("/"))):
        raise HTTPException(404, "not found")
    return FileResponse(full, headers=NO_CACHE)
