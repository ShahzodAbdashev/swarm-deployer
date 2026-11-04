"""Request helpers."""
import urllib.request

from backend.core.errors import bad


def cross_site(request):
    """A write from another web page (body-less POSTs pass the JSON content-type check): its Origin is not us."""
    o = request.headers.get("origin")
    return (request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/") and o is not None
            and urllib.parse.urlsplit(o).netloc != request.headers.get("host"))


def obj(body):
    if body is None:
        return {}
    if not isinstance(body, dict):
        bad("body: must be a JSON object")
    return body
