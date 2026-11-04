"""Swarm targets (SSH servers)."""
from fastapi import APIRouter, Body

from backend.api.deps import obj
from backend.config.store import find, load_config, public, update_config
from backend.core.errors import bad
from backend.remote.ssh import probe_target
from backend.validators.settings import check_target

router = APIRouter()


@router.post("/api/targets", status_code=201)
def add_target(body: dict = Body(default={})):
    t = check_target(obj(body))

    def apply(cfg):
        if find(cfg["targets"], "id", t["id"]):
            bad(f"id: target {t['id']} already exists", 409)
        cfg["targets"].append(t)
        return public(t)
    return update_config(apply)


@router.put("/api/targets/{tid}")
def put_target(tid: str, body: dict = Body(default={})):
    def apply(cfg):
        old = find(cfg["targets"], "id", tid)
        if not old:
            bad("target not found", 404)
        t = check_target({**obj(body), "id": tid}, old)
        cfg["targets"][cfg["targets"].index(old)] = t
        return public(t)
    return update_config(apply)


@router.delete("/api/targets/{tid}")
def delete_target(tid: str):
    def apply(cfg):
        t = find(cfg["targets"], "id", tid)
        if not t:
            bad("target not found", 404)
        cfg["targets"].remove(t)
        return {"deleted": True}
    return update_config(apply)


@router.post("/api/targets/{tid}/test")
def test_target(tid: str, body: dict | None = Body(default=None)):
    old = find(load_config()["targets"], "id", tid)
    if not old:
        bad("target not found", 404)
    over = dict(obj(body))
    if not over.get("password"):
        over.pop("password", None)
    return probe_target(check_target({**over, "id": tid}, old))
