"""Serves the built React UI."""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from backend.core.paths import DIST

router = APIRouter()


@router.get("/")
def index():
    page = os.path.join(DIST, "index.html")
    if not os.path.isfile(page):
        return PlainTextResponse("UI not built: run ./run.sh (or cd frontend && npm ci && npm run build)", status_code=503)
    return FileResponse(page, media_type="text/html")


@router.get("/assets/{name}")
def asset(name: str):
    path = os.path.join(DIST, "assets", os.path.basename(name))  # flat dir: no traversal
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})
