"""The page shown inside HighLevel: data side only (routes and HTML come with issue #134).

Every function takes one location id and reads or writes only that location, through the shared Store."""
import store
import runs

MAX_PROMPT_CHARS = 200


def page_view(location_id):
    """Everything the page shows for one location, or None if it is not installed."""
    st = store.get_store()
    loc = st.get_location(location_id)
    if not loc:
        return None
    custom = st.list_prompts(location_id)
    month = runs._utc().strftime("%Y-%m")
    return {
        "location_id": location_id,
        "business": {"name": loc["name"], "website": loc["website"], "category": loc["category"], "city": loc["city"]},
        "plan": loc["plan"],
        "prompts": [p["text"] for p in custom] if custom else runs.default_prompts(loc),
        "custom_prompts": bool(custom),
        "trend": st.trend(location_id),
        "latest": {eng: rs[0] for eng, rs in st.history(location_id, 1).items() if rs},
        "spend_month_usd": round(st.spend_total(month, location_id), 6),
    }


def save_prompts(location_id, prompts):
    """Replace the location's prompts (at most 10, trimmed, blanks dropped; [] restores the defaults)."""
    st = store.get_store()
    if not st.get_location(location_id):
        raise store.StoreError("not_installed", "location is not installed")
    clean = [str(p).strip()[:MAX_PROMPT_CHARS] for p in prompts or [] if str(p).strip()]
    return [p["text"] for p in st.replace_prompts(location_id, clean)]


def run_now(location_id, now=None):
    """Start an on-demand run (one per UTC day); see runs.run_now."""
    return runs.run_now(location_id, now)


def handle_todo(req):
    # TODO: replace with the real route (issue #134).
    return 501, {"error": {"code": "not_implemented", "message": "page is not built yet", "details": {}}}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/page/todo")] = handle_todo
