""".env parsing."""
import re

from backend.core.errors import bad
from backend.envimport.keys import ENV_BOOL


ENV_LINE_RE = re.compile(r"[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*")  # KEY = v too, like BP


def parse_env(text):
    """KEY=VALUE lines -> dict (last wins). '…' literal, "…" with \\n \\" \\\\, both may span lines; no $VAR."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out, pos, n = {}, 0, len(text)
    while pos < n:
        eol = text.find("\n", pos)
        eol = n if eol < 0 else eol
        m = ENV_LINE_RE.match(text, pos)
        if not m or m.end() > eol:  # blank line, comment or junk
            pos = eol + 1
            continue
        key, p = m[1], m.end()
        q = text[p:p + 1]
        end = -1
        if q == "'":
            end = text.find("'", p + 1)
            val = text[p + 1:end]
        elif q == '"':
            buf, i = [], p + 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    buf.append({"n": "\n", '"': '"', "\\": "\\"}.get(text[i + 1], text[i:i + 2]))
                    i += 2
                else:
                    buf.append(text[i])
                    i += 1
            end, val = (i if i < n else -1), "".join(buf)
        if end < 0:  # unquoted, or an unterminated quote: the rest of the line
            val = re.sub(r"\s+#.*$", "", text[p:eol]).strip()
            if q in ("'", '"'):
                val = val[1:]
            pos = eol + 1
        else:
            nl = text.find("\n", end)
            pos = n if nl < 0 else nl + 1
        out[key] = val
    return out


def env_int(v, key):
    try:
        return int(str(v).strip())
    except ValueError:
        bad(f"{key}: must be an integer")


def env_bool(v, key):
    b = ENV_BOOL.get(str(v).strip().lower())
    if b is None:
        bad(f"{key}: must be true or false")
    return b
