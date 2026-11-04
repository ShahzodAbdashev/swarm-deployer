""".env parsing and secret detection."""
import re

from backend.core.patterns import SECRET_KEY_RE


def parse_env(text):
    """.env parser (same rules as Swarm Deployer): [export ]KEY=VALUE, '...' literal, "..." with \\n \\" \\\\,
    both may span lines; unquoted values lose a ' #comment'. No $VAR expansion. Last occurrence wins."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out, lines, i = {}, text.split("\n"), 0
    while i < len(lines):
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$", lines[i])
        i += 1
        if not m:
            continue
        key, v = m.group(1), m.group(2).lstrip()
        if v[:1] in ("'", '"'):
            q, rest, j = v[0], v[1:], i
            buf = rest
            while True:  # find the closing quote, joining following lines
                end = buf.find("'") if q == "'" else _dq_end(buf)
                if end >= 0 or j >= len(lines):
                    break
                buf += "\n" + lines[j]
                j += 1
            if end >= 0:
                val = buf[:end]
                if q == '"':
                    val = re.sub(r'\\(["\\n])', lambda x: "\n" if x.group(1) == "n" else x.group(1), val)
                out[key], i = val, j
                continue
            v = rest  # unterminated quote: treat the rest of this line as an unquoted value
        out[key] = re.sub(r"\s+#.*$", "", v).strip()
    return out


def _dq_end(s):
    i = 0
    while i < len(s):
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == '"':
            return i
        i += 1
    return -1


def env_secrets(kv):
    """Env values to mask: secret-named keys >= 3 chars, any value >= 8 chars (GitLab's masked minimum).
    ponytail: short values under neutral names stay readable in logs (e.g. 8084, dev)."""
    return [v for k, v in kv.items() if v and ((SECRET_KEY_RE.search(k) and len(v) >= 3) or len(v) >= 8)]
