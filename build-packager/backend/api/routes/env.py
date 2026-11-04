""".env import."""
from fastapi import APIRouter

from backend.api.schemas import ContentIn
from backend.core.errors import bad
from backend.envfile.apply import apply_env
from backend.envfile.parser import parse_env

router = APIRouter()


@router.post("/api/config/import-env")
def import_env(body: ContentIn):
    kv = parse_env(body.content) if 0 < len(body.content) <= 262144 else {}
    if not kv:
        bad("content: no KEY=value lines")
    return apply_env(kv)
