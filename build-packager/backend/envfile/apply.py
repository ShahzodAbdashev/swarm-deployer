"""Apply a .env to the settings (also at startup)."""
import hashlib
import os
import sys

from fastapi import HTTPException

from backend.config.store import load_config, update_config
from backend.core.enums import GitlabMethod, Protocol
from backend.core.errors import bad
from backend.core.paths import BASE
from backend.envfile.parser import parse_env
from backend.gitlab.client import gl_base, gl_clean_url, gl_clear
from backend.utils.dates import now_iso
from backend.validators.upload import check_upload


ENV_UPLOAD = {"PROTOCOL": "protocol", "HOST": "host", "PORT": "port", "USER": "username", "PASSWORD": "password",
              "DOMAIN": "domain", "SHARE": "share", "REMOTE_DIR": "remote_dir", "KEY_PATH": "private_key_path"}


ENV_GITLAB = {"GITLAB_URL": "gitlab_url", "GITLAB_TOKEN": "gitlab_token", "GITLAB_CLIENT_ID": "gitlab_client_id",
              "GITLAB_CLIENT_SECRET": "gitlab_client_secret"}


def apply_env(kv):
    """Import .env keys into config (B.7). Returns names only, never values. Unknown and deployer keys -> ignored."""
    done, errors = [], []
    known = set(ENV_GITLAB) | {"FILE_SERVER_" + k for k in ENV_UPLOAD} | {"BP_UPLOAD_ENABLED"}
    ignored = [k for k in kv if k not in known]
    gl = {ENV_GITLAB[k]: v.strip() for k, v in kv.items() if k in ENV_GITLAB}
    if gl:
        try:
            if "gitlab_url" in gl:
                gl["gitlab_url"] = gl_clean_url(gl["gitlab_url"])

            def apply_gl(c):
                tok = gl.pop("gitlab_token", None)
                c.update(gl)
                if tok is not None:
                    gl_clear(c)
                    c.update(gitlab_token=tok or None, gitlab_token_url=gl_base(c) if tok else "",
                             gitlab_method=GitlabMethod.PAT if tok else None)
            names = list(gl)  # apply_gl pops the token
            update_config(apply_gl)
            done += names
        except HTTPException as e:
            errors.append(f"gitlab: {e.detail}")
    up = {ENV_UPLOAD[k[12:]]: v for k, v in kv.items() if k.startswith("FILE_SERVER_") and k[12:] in ENV_UPLOAD}
    if "BP_UPLOAD_ENABLED" in kv:
        up["enabled"] = kv["BP_UPLOAD_ENABLED"].strip().lower() in ("1", "true", "yes", "on")
    elif up.get("host"):
        up["enabled"] = True
    if up:
        try:
            cur = load_config()["upload"]
            if "port" in up:
                if not up["port"].strip().isdigit():
                    bad("port: must be 1-65535")
                up["port"] = int(up["port"])
            elif "protocol" in up and up["protocol"] != cur["protocol"]:
                up["port"] = {Protocol.SFTP: 22, Protocol.SMB: 445}.get(up["protocol"], 21)
            new = check_upload({**cur, **up})
            update_config(lambda c: c.update(upload=new))
            done += ["upload." + k for k in up]
        except HTTPException as e:
            errors.append(f"upload: {e.detail}")
    return {"set": done, "ignored": ignored, "errors": errors}


def startup_env_import():
    path = os.environ.get("BP_ENV_FILE") or os.path.join(BASE, ".env")
    try:
        with open(path, "rb") as f:
            raw = f.read()
        sha = hashlib.sha256(raw).hexdigest()
        if sha == load_config()["env_import_sha"]:
            return
        r = apply_env(parse_env(raw.decode("utf-8", "replace")))
        update_config(lambda c: c.update(env_import_sha=sha, env_import_at=now_iso()))
        print(f"env import: set {', '.join(r['set']) or '-'}; ignored {', '.join(r['ignored']) or '-'}; "
              f"errors {'; '.join(r['errors']) or '-'}", file=sys.stderr)
    except FileNotFoundError:
        pass
    except Exception as e:  # never fail startup because of the .env
        print(f"env import failed: {e.__class__.__name__}", file=sys.stderr)
