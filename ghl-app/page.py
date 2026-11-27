"""Stub: the page shown inside HighLevel. Owned by its own issue; app.py needs no edit."""
import config


def handle_todo(req):
    # TODO: replace with the real route.
    return 501, {"error": {"code": "not_implemented", "message": "page is not built yet", "details": {}}}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/page/todo")] = handle_todo
