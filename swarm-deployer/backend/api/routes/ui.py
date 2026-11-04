"""Serves the static UI in frontend/ (plain HTML/CSS/ES modules, no build step)."""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.core.paths import UI

router = APIRouter()

NO_CACHE = {"Cache-Control": "no-cache"}  # revalidate every load (ETag/Last-Modified): edits show up on reload


@router.get("/")
def index():
    return FileResponse(os.path.join(UI, "index.html"), media_type="text/html", headers=NO_CACHE)


@router.get("/{path:path}")
def static(path: str):
    """Any file inside frontend/ by relative path; nothing outside it (no traversal, no dotfiles)."""
    full = os.path.realpath(os.path.join(UI, path))
    if (not full.startswith(UI + os.sep) or any(p.startswith(".") for p in path.split("/"))
            or path.startswith("api/") or not os.path.isfile(full)):
        raise HTTPException(404, "not found")
    return FileResponse(full, headers=NO_CACHE)
