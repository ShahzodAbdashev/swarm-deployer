"""Time stamps."""
from datetime import datetime


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def ts_iso(ts):
    return datetime.strptime(ts, "%Y%m%d_%H%M%S").isoformat(timespec="seconds")


def mtime_key(mtime):
    return datetime.fromtimestamp(mtime).strftime("%Y%m%d_%H%M%S") if mtime else ""
