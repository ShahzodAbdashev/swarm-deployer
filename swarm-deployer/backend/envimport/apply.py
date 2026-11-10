"""Apply a parsed .env (or GitLab CI/CD variables) to the settings."""
import hashlib
import os
import sys

from fastapi import HTTPException

from backend.config.store import find, load_config, update_config
from backend.core.constants import OPTION_RULES
from backend.core.errors import bad
from backend.core.paths import BASE, KEYS
from backend.core.patterns import TID_RE
from backend.envimport.keys import ENV_KEY, ENV_KEYS, ENV_OPT_BOOL, ENV_OPT_INT, ENV_REGISTRY, ENV_TARGET
from backend.envimport.parser import env_bool, env_int, parse_env
from backend.gitlab.client import gl_base
from backend.utils.dates import now_iso
from backend.validators.fields import v_gl_url, v_int, v_str
from backend.validators.settings import check_target


def write_key(tid, text):
    """Key content -> DATA/keys/<tid>, mode 600 even over an existing 0644 file; a planted symlink fails."""
    os.makedirs(KEYS, mode=0o700, exist_ok=True)
    os.chmod(KEYS, 0o700)
    path = os.path.join(KEYS, tid)
    data = (text.replace("\r\n", "\n").replace("\r", "\n").strip("\n") + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    except OSError as e:
        bad(f"ssh key: cannot write {path}: {e.strerror}")
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, data)
    finally:
        os.close(fd)
    return path


def apply_env(kv, target_id=None, project=None, source=".env"):
    """Apply .env / GitLab variables to the config. Returns setting names only, never values."""
    res = {"set": [], "ignored": [], "errors": []}
    E = {}
    for k, v in kv.items():
        if v is None:  # GitLab "masked and hidden"
            if k in ENV_KEYS:
                res["errors"].append(f"{k} is hidden in GitLab; its value can't be read")
            else:
                res["ignored"].append(k)
        elif k not in ENV_KEYS or (source == "gitlab" and (k.startswith("GITLAB_") or
                                                           k in ("SD_HOST_KEY_POLICY", "SD_DOCKER_CMD"))):
            res["ignored"].append(k)
        else:
            E[k] = v

    def g(*keys):  # native key first, then the CI alias
        return next((E[k] for k in keys if k in E), None)

    def section(name, fn):
        try:
            res["set"] += update_config(fn) or []
        except HTTPException as e:
            res["errors"].append(f"{name}: {e.detail}")

    def s_gitlab(cfg):
        gl, out = cfg["gitlab"], []
        if "GITLAB_URL" in E:
            url = v_gl_url(E["GITLAB_URL"], "GITLAB_URL")
            if url != gl_base(cfg) and not E.get("GITLAB_TOKEN"):
                gl["token"] = ""  # a saved token belongs to its GitLab
            gl["url"] = url
            out.append("gitlab.url")
        if E.get("GITLAB_TOKEN"):
            gl["token"] = v_str(E["GITLAB_TOKEN"].strip(), "GITLAB_TOKEN", 1024)
            out.append("gitlab.token")
        return out
    if any(k.startswith("GITLAB_") for k in E):
        section("gitlab", s_gitlab)

    cfg0 = load_config()
    tid = g("SD_TARGET_ID") or target_id or (cfg0["targets"][0]["id"] if len(cfg0["targets"]) == 1 else "dev")
    tfields = {f: g(*ks) for f, ks in ENV_TARGET.items() if g(*ks) is not None}
    reg = {f: g(*ks) for f, ks in ENV_REGISTRY.items() if g(*ks) is not None}
    key = g(*ENV_KEY)
    if key and "\n" not in key and "\\n" in key and "-----BEGIN" in key:  # single-line CI paste with literal \n
        key = key.replace("\\n", "\n")
    if source == "gitlab" and reg.get("url") and "username" not in reg and "password" not in reg:
        res["errors"].append("registry credentials not found in GitLab variables (CI_REGISTRY_USER/PASSWORD are "
                             "per-job tokens there); set them in Settings → Targets")
        reg = {}  # never pair a new registry URL with the old saved password
    tid_ok = bool(TID_RE.fullmatch(tid))
    if (tfields or reg or key is not None) and not tid_ok:
        res["errors"].append(f"target: id {tid[:40]!r} is not a valid target id (a-z, 0-9, -)")
    elif tfields or reg or key is not None:
        def s_target(cfg):
            old = find(cfg["targets"], "id", tid)
            body = dict(tfields, id=tid)
            if "port" in body:
                body["port"] = env_int(body["port"], "SD_TARGET_PORT")
            out = [f"targets.{tid}.{f}" for f in tfields]
            if reg:
                body["registry"] = reg
                out += [f"targets.{tid}.registry.{f}" for f in reg]
            if not old:
                if not (body.get("host") and body.get("username")):
                    bad(f"target {tid} does not exist; SD_TARGET_HOST and SD_TARGET_USER are needed to create it")
                home = "/root" if body["username"] == "root" else f"/home/{body['username']}"
                body.setdefault("backup_dir", f"{home}/sd-backups")
            t = check_target(body, old)
            if key is not None:
                if key.startswith("/") and "\n" not in key.strip():
                    t["private_key_path"] = v_str(key.strip(), "ssh key path")
                    out.append(f"targets.{tid}.private_key_path")
                elif "-----BEGIN" in key and "-----END" in key:
                    t["private_key_path"] = write_key(tid, key)
                    out.append(f"targets.{tid}.private_key_path")
                else:
                    res["errors"].append("ssh key: incomplete — quote multi-line values in .env")
            if old:
                cfg["targets"][cfg["targets"].index(old)] = t
            else:
                cfg["targets"].append(t)
            return list(dict.fromkeys(out))
        section("target", s_target)

    def s_options(cfg):
        out = []
        for k, f in ENV_OPT_INT.items():
            if k in E:
                cfg["options"][f] = v_int(env_int(E[k], k), k, *OPTION_RULES[f])
                out.append(f"options.{f}")
        for k, f in ENV_OPT_BOOL.items():
            if k in E:
                cfg["options"][f] = env_bool(E[k], k)
                out.append(f"options.{f}")
        return out
    if any(k in E for k in (*ENV_OPT_INT, *ENV_OPT_BOOL)):
        section("options", s_options)

    return res


def env_startup_import():
    """<app>/.env (or SD_ENV_FILE) is imported once per content sha. Never fails startup; prints names only."""
    path = os.environ.get("SD_ENV_FILE") or os.path.join(BASE, ".env")
    try:
        if not os.path.isfile(path):
            return
        with open(path, "rb") as f:
            raw = f.read()
        sha = hashlib.sha256(raw).hexdigest()
        if sha == load_config()["env_import"]["sha"]:
            return
        res = apply_env(parse_env(raw.decode("utf-8", "replace")), source=".env")

        def apply(c):
            c["env_import"] = {"sha": sha, "at": now_iso(), "set": res["set"]}
        update_config(apply)
        print(f"env import: set {', '.join(res['set']) or '-'}; ignored {', '.join(res['ignored']) or '-'}; "
              f"errors {'; '.join(res['errors']) or '-'}", file=sys.stderr)
    except Exception as e:
        print(f"env import: failed ({type(e).__name__})", file=sys.stderr)
