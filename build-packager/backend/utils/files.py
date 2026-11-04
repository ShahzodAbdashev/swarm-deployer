"""Atomic private JSON writes."""
import json
import os


def write_json(path, obj, mode=None):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode or 0o666)  # secrets: private from the first byte
    if mode:
        os.fchmod(fd, mode)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)
    if mode:
        os.chmod(path, mode)
