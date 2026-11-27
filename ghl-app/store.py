"""Stub: storage (locations, tokens, answers). Owned by its own issue; app.py needs no edit."""
import config


def handle_todo(req):
    # TODO: replace with the real route.
    return 501, {"error": {"code": "not_implemented", "message": "store is not built yet", "details": {}}}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/store/todo")] = handle_todo
