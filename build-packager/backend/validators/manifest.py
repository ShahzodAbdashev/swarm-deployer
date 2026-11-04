"""deploy.yml manifest check."""
import re

import yaml

from backend.core.constants import MANIFEST_KEYS
from backend.core.patterns import DOCKER_REPO_RE, NAME_RE


def check_manifest(text):
    """Parse + validate a deploy.yml. Returns the dict or raises ValueError with a readable message."""
    try:
        m = yaml.safe_load(text)
    except yaml.YAMLError as e:
        raise ValueError(f"not valid YAML: {str(e).splitlines()[0]}")
    if not isinstance(m, dict):
        raise ValueError("must be a mapping of key: value")
    unknown = sorted(str(k) for k in m if k not in MANIFEST_KEYS)
    if unknown:
        raise ValueError(f"unknown key(s) {', '.join(unknown)} (allowed: {', '.join(sorted(MANIFEST_KEYS))})")
    for k, v in m.items():
        if not isinstance(v, str):
            raise ValueError(f"{k}: must be a string")
    if not NAME_RE.match(m.get("service", "")):
        raise ValueError("service: required, a swarm service name like mystack_web")
    if not (DOCKER_REPO_RE.fullmatch(m.get("image", "")) and len(m["image"]) <= 200):
        raise ValueError("image: required, a lowercase docker repository like registry:5000/team/app")
    if "target" in m and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", m["target"]):
        raise ValueError("target: must be a target id like lab or prod-1")
    if "health_url" in m and not re.fullmatch(r"https?://\S{1,490}", m["health_url"]):
        raise ValueError("health_url: must be an http(s) URL")
    if "moving_tag" in m and m["moving_tag"] not in ("", "@current") and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", m["moving_tag"]):
        raise ValueError("moving_tag: invalid docker tag")
    return m
