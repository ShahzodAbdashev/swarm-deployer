""".gitlab-ci.yml shipped inside the package zip: where the deploy goes (the same variables the CI deploy job uses)."""
import yaml


class _CILoader(yaml.SafeLoader):
    """GitLab tags (!reference, ...) load as None instead of failing."""


_CILoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def _literal(v):
    """A variable's value if it is a plain literal (GitLab also allows {value: ..., description: ...})."""
    if isinstance(v, dict):
        v = v.get("value")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        v = str(v)
    return v.strip() if isinstance(v, str) and v.strip() and "$" not in v else None


def deploy_vars(text):
    """{"service": SERVICE_NAME, "tag": DEV_IMAGE_TAG, "health_url": HEALTHCHECK_URL} from the top-level `variables:` (None when missing or when
    the value references another variable). Raises ValueError on invalid YAML."""
    try:
        doc = yaml.load(text, Loader=_CILoader) or {}
    except yaml.YAMLError as e:
        raise ValueError(f".gitlab-ci.yml: invalid YAML ({type(e).__name__})")
    vs = doc.get("variables") if isinstance(doc, dict) else None
    vs = vs if isinstance(vs, dict) else {}
    return {"service": _literal(vs.get("SERVICE_NAME")), "tag": _literal(vs.get("DEV_IMAGE_TAG")),
            "health_url": _literal(vs.get("HEALTHCHECK_URL"))}


if __name__ == "__main__":  # self-check
    y = 'variables:\n  SERVICE_NAME: "fortress_search"\n  DEV_IMAGE_TAG: {value: dev, description: x}\n' \
        'job:\n  script: [!reference [.a, script]]\n'
    assert deploy_vars(y) == {"service": "fortress_search", "tag": "dev", "health_url": None}, deploy_vars(y)
    assert deploy_vars("variables:\n  SERVICE_NAME: $X\n")["service"] is None
    assert deploy_vars("stages: [a]\n") == {"service": None, "tag": None, "health_url": None}
    print("ci_file ok")
