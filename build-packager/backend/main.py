"""FastAPI app: middleware, routers, startup."""
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

from backend.api.routes import auth, env, github, gitlab, jobs, ui, upload
from backend.envfile.apply import startup_env_import
from backend.jobs.manager import recover_interrupted


app = FastAPI(title="Build Packager")


@app.middleware("http")
async def same_origin(request: Request, call_next):
    """A write from another web page (body-less POSTs pass the JSON content-type check): its Origin is not us."""
    o = request.headers.get("origin")
    if (request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/") and o is not None
            and urlsplit(o).netloc != request.headers.get("host")):
        return JSONResponse({"detail": "cross-site request refused"}, status_code=403)
    return await call_next(request)


# blocks DNS-rebinding pages from driving the API (build_command = shell exec)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


for r in (ui, auth, gitlab, env, github, upload, jobs):
    app.include_router(r.router)


def startup():
    """Runs once on import (uvicorn app:app): recover interrupted jobs, then the startup .env import."""
    recover_interrupted()
    startup_env_import()


startup()
