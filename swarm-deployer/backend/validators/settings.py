"""Validation of file server and targets."""
import copy
import os
import re

from backend.core.constants import DOCKER_CMDS, POLICIES, TARGET_DEFAULTS
from backend.core.errors import bad
from backend.core.patterns import REG_URL_RE, REG_USER_RE, TID_RE, USER_RE
from backend.validators.fields import clean_remote_dir, v_host, v_int, v_re, v_str


def check_file_server(fs):
    if fs.get("protocol", "sftp") not in ("sftp", "local"):
        bad("protocol: sftp or local")
    if fs.get("protocol") == "local":  # a folder on this computer: only the path matters
        p = v_str(fs["remote_dir"], "remote_dir", 1024).strip()
        if not p.startswith("/") or not os.path.isdir(p):
            bad("remote_dir: an existing folder on this computer, like /home/me/releases")
        fs["remote_dir"] = os.path.normpath(p)
        return fs
    fs["host"] = v_str(fs["host"], "host", 253).strip()
    if fs["host"]:
        v_host(fs["host"], "host")
    v_int(fs["port"], "port", 1, 65535)
    v_str(fs["username"], "username", 64)
    if fs["username"]:
        v_re(fs["username"], "username", USER_RE)
    v_str(fs["password"], "password")
    v_str(fs["private_key_path"], "private_key_path")
    fs["remote_dir"] = clean_remote_dir(fs["remote_dir"])
    return fs


def check_ssh_part(t, field):
    t["host"] = v_host(t.get("host"), f"{field}host")
    v_int(t.get("port"), f"{field}port", 1, 65535)
    v_re(t.get("username"), f"{field}username", USER_RE)
    v_str(t.get("password", ""), f"{field}password")
    v_str(t.get("private_key_path", ""), f"{field}private_key_path")


def drop_moved_pw(new, old, body):
    """A saved password belongs to its host: never send it to a new one."""
    if "password" not in body and str(new.get("host") or "").strip() != str(old.get("host") or "").strip():
        new["password"] = ""


def check_target(body, old=None):
    if not isinstance(body, dict):
        bad("body: must be an object")
    t = copy.deepcopy(old or TARGET_DEFAULTS)
    t.update({k: v for k, v in body.items() if k in TARGET_DEFAULTS and k not in ("extra_nodes", "registry")})
    if old:
        drop_moved_pw(t, old, body)
    if "registry" in body:
        r = body["registry"] if isinstance(body["registry"], dict) else bad("registry: must be an object")
        reg = {"url": "", "username": "", "password": "", **(t.get("registry") or {})}
        if "url" in r and str(r["url"]).strip() != reg["url"]:  # same rule for the registry credentials
            reg.update(username="", password="")
        reg.update({k: r[k] for k in ("url", "username", "password") if k in r})
        t["registry"] = reg
    reg = t["registry"] = {"url": "", "username": "", "password": "", **(t.get("registry") or {})}
    reg["url"] = v_str(reg["url"], "registry.url", 253).strip()
    if reg["url"]:
        v_re(reg["url"], "registry.url", REG_URL_RE, "host and port only, like 192.192.192.175:5050")
        v_re(reg["username"], "registry.username", REG_USER_RE, "required when a registry is set")
        if not reg["password"]:
            bad("registry.password: required when a registry is set")
    else:
        v_str(reg["username"], "registry.username", 128)
    v_str(reg["password"], "registry.password")
    v_re(t["id"], "id", TID_RE)
    t["name"] = v_str(t["name"] or t["id"], "name", 100)
    check_ssh_part(t, "")
    v_re(t["host_key_policy"], "host_key_policy", re.compile("|".join(POLICIES)), "must be auto_add, warn or reject")
    if t["docker_cmd"] not in DOCKER_CMDS:
        bad('docker_cmd: must be "docker" or "sudo -n docker"')
    t["work_dir"] = clean_remote_dir(t["work_dir"], "work_dir")
    t["backup_dir"] = clean_remote_dir(t["backup_dir"], "backup_dir")
    if "extra_nodes" in body:
        if not isinstance(body["extra_nodes"], list):
            bad("extra_nodes: must be a list")
        nodes = []
        for i, n in enumerate(body["extra_nodes"]):
            if not isinstance(n, dict):
                bad(f"extra_nodes[{i}]: must be an object")
            node = {"host": n.get("host"), "port": n.get("port", 22), "username": n.get("username"),
                    "private_key_path": n.get("private_key_path", "")}
            check_ssh_part(node, f"extra_nodes[{i}].")
            if "password" in n:
                node["password"] = n["password"]
            else:  # omitted password for the same host:port keeps the stored one
                prev = next((o for o in t["extra_nodes"] if o["host"] == node["host"] and o["port"] == node["port"]), {})
                node["password"] = prev.get("password", "")
            v_str(node["password"], f"extra_nodes[{i}].password")
            nodes.append(node)
        t["extra_nodes"] = nodes
    return t
