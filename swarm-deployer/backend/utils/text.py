"""Small text helpers."""
import json


def hsize(n):
    n = n or 0
    return f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{n / 1e3:.0f} KB"


def last_line(out):
    lines = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    return lines[-1][:200] if lines else ""


def jparse(out):
    """Last JSON object/array/null line of a command output (docker may print warnings first)."""
    for line in reversed((out or "").splitlines()):
        line = line.strip()
        if line == "null":
            return None
        if line and line[0] in "{[":
            try:
                return json.loads(line)
            except ValueError:
                pass
    return None
