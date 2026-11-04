""".gitlab-ci.yml export_env heredoc -> .env rendering."""
import posixpath
import re

import yaml

from backend.core.errors import bad


CI_RESERVED = {"default", "include", "stages", "variables", "workflow", "image", "services", "before_script",
               "after_script", "cache"}


HEREDOC_RE = re.compile(r"""<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2""")


REDIR_RE = re.compile(r"""(>>?)\s*(['"]?)([^\s'";&|]+)\2""")


ENV_KEY_RE = re.compile(r"^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


VAR_RE = re.compile(r"\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)")


class _CILoader(yaml.SafeLoader):
    pass


_CILoader.add_multi_constructor("!", lambda loader, suffix, node: None)  # GitLab !reference etc. -> None


def _flat(x):
    if isinstance(x, str):
        return x.split("\n")
    if isinstance(x, list):
        return [ln for i in x for ln in _flat(i)]
    return []


def _env_redirect(line):
    for m in REDIR_RE.finditer(line):
        t = m.group(3)
        if (posixpath.basename(t) == ".env") if "$" in t else t.endswith(".env"):
            return m.group(1), t
    return None


def _heredocs(lines):
    """[(redirect, target, expand, body_lines)] for every heredoc into an env file, plus warnings."""
    out, warns, i = [], [], 0
    while i < len(lines):
        h, r = HEREDOC_RE.search(lines[i]), _env_redirect(lines[i])
        i += 1
        if not (h and r):
            continue
        tag, body = h.group(3), []
        while i < len(lines) and lines[i].strip() != tag:
            body.append(lines[i].lstrip("\t") if h.group(1) else lines[i])
            i += 1
        if i >= len(lines):
            warns.append(f"heredoc {tag}: not terminated, read to the end of the script")
        i += 1
        out.append((r[0], r[1], not h.group(2), body))
    return out, warns


def parse_ci_env(text, job="export_env"):
    """Find the job whose script writes .env via a heredoc. Returns {job, target, lines: [(text, expand)],
    job_vars, top_vars, warnings}. Raises 400."""
    try:
        doc = yaml.load(text, Loader=_CILoader)
    except yaml.YAMLError as e:
        bad(f".gitlab-ci.yml: not valid YAML: {str(e).splitlines()[0]}")
    if not isinstance(doc, dict):
        bad(".gitlab-ci.yml: must be a mapping")
    jobs = [k for k, v in doc.items() if isinstance(v, dict) and str(k) not in CI_RESERVED]

    def docs_of(name):
        j = doc[name]
        return _heredocs(_flat(j.get("before_script")) + _flat(j.get("script")))

    name = job if isinstance(doc.get(job), dict) else next((k for k in jobs if docs_of(k)[0]), None)
    found, warns = docs_of(name) if name is not None else ([], [])
    if not found:
        bad(f"job: no job writes .env with a heredoc (jobs: {', '.join(map(str, jobs)) or 'none'})")
    if "include" in doc:
        warns.append("include: not followed")
    lines = []
    for redirect, _t, expand, body in found:
        if redirect == ">":
            lines = []
        lines += [(ln, expand) for ln in body]

    def yvars(d):
        d = d if isinstance(d, dict) else {}
        return {str(k): {"value": "" if v is None else str(v.get("value", "") if isinstance(v, dict) else v),
                         "raw": False} for k, v in d.items()}
    return {"job": str(name), "target": found[0][1], "lines": lines, "job_vars": yvars(doc[name].get("variables")),
            "top_vars": yvars(doc.get("variables")), "warnings": warns}


def render_env(parsed, levels):
    """Expand the heredoc lines against levels [(source, {key: entry})] (first level wins).
    Returns the env-preview fields: content, lines, keys, missing, sources, warnings."""
    sources, missing, warns, cache = {}, [], list(parsed["warnings"]), {}

    def miss(n):
        if n not in missing:
            missing.append(n)

    def lookup(n, nested=False):
        if (n, nested) in cache:
            return cache[(n, nested)]
        for src, table in levels:
            if n in table:
                e = table[n]
                sources[n] = src
                if e["value"] is None:
                    warns.append(f"{n} is hidden in GitLab; its value can't be read")
                    val = None
                else:
                    val = e["value"]
                    if e.get("file"):
                        warns.append(f"{n} is a file variable; its content is used")
                    if not e.get("raw") and not nested:
                        val = expand(val, lambda m: lookup(m, True), [], None)
                break
        else:
            val = None
        cache[(n, nested)] = val
        return val

    def expand(s, look, used, lineno, used_missing=None):
        used_missing = [] if used_missing is None else used_missing
        if lineno is not None and ("$(" in s or "`" in s):
            warns.append(f"line {lineno}: command substitution not supported")

        def sub(m):
            if m.group(0) == "\\$":
                return "$"
            name = m.group(1) or m.group(4)
            used.append(name)
            val = look(name)
            if m.group(2) == ":-":
                return val if val else m.group(3)
            if m.group(2) == "-":
                return m.group(3) if val is None else val
            if val is None:
                miss(name)
                used_missing.append(name)
                return ""
            return val
        return VAR_RE.sub(sub, s)

    out, lines, keys = [], [], []
    for n, (text, do_expand) in enumerate(parsed["lines"], 1):
        km, used, lm, val = ENV_KEY_RE.match(text), [], [], text  # comments and blanks stay verbatim
        if km:
            val = expand(text, lookup, used, n, lm) if do_expand else text
            lines.append({"key": km.group(2), "vars": used, "status": "literal" if not used else "missing" if lm else "ok"})
            if km.group(2) not in keys:
                keys.append(km.group(2))
        out.append(val)
    content = "\n".join(out) + "\n" if out else ""
    return {"content": content, "lines": lines, "keys": keys, "missing": missing,
            "sources": sources, "warnings": list(dict.fromkeys(warns))}
