"""FastAPI app: middleware, routers, startup."""
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

from backend.api.deps import cross_site
from backend.api.routes import deploys, env, packages, services, settings, targets, ui
from backend.envimport.apply import env_startup_import
from backend.jobs.manager import recover_interrupted


app = FastAPI(title="Swarm Deployer")


@app.middleware("http")
async def gate(request: Request, call_next):
    """Local single-user tool: no sign-in. Writes from other web pages are refused (runs after TrustedHost)."""
    if cross_site(request):
        return JSONResponse({"detail": "cross-site request refused"}, status_code=403)
    return await call_next(request)


app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.exception_handler(RequestValidationError)
async def validation_400(_req, exc):
    e = (exc.errors() or [{}])[0]
    field = ".".join(str(x) for x in e.get("loc", [])[1:]) or "body"
    return JSONResponse({"detail": f"{field}: {e.get('msg', 'invalid')}"}, status_code=400)


for r in (ui, settings, targets, packages, services, deploys, env):
    app.include_router(r.router)


def startup():
    """Runs once on import (uvicorn app:app): startup .env import, recovery of interrupted jobs."""
    env_startup_import()
    recover_interrupted()


startup()
