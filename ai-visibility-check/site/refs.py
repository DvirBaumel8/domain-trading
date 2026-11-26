"""Referral tags (?ref=): one sanitizer, the page-hit log, and the helpers the weekly count uses.
Stdlib only. A ref is never a file name, path, header or unescaped HTML."""
import datetime, re, urllib.parse

_OK = re.compile(r"[A-Za-z0-9._-]{1,32}")
MAX_PATH = 80
HITS_FILE = "ref-hits.jsonl"


def clean_ref(value):
    """Normalized ref, or "" if invalid. Invalid input is dropped, never repaired."""
    if not isinstance(value, str):
        return ""
    v = value.strip()
    # validate the ASCII form first, then lowercase (so e.g. the Kelvin sign cannot become "k")
    return v.lower() if _OK.fullmatch(v) else ""


def ref_from_target(target):
    """First ref= value of a request target's query string, sanitized ("" if none/invalid)."""
    q = urllib.parse.urlsplit(target).query
    vals = urllib.parse.parse_qs(q, keep_blank_values=True, max_num_fields=50).get("ref")
    return clean_ref(vals[0]) if vals else ""


def hit_path(file_path, root):
    """Public path of a served HTML file: /index.html -> /, else /name.html. "" if not usable."""
    rel = file_path[len(root):].replace("\\", "/").lstrip("/") if file_path.startswith(root) else ""
    if not rel.endswith(".html") or len(rel) + 1 > MAX_PATH:
        return ""
    return "/" if rel == "index.html" else "/" + rel


def record_hit(target, file_path, root, data_dir, save_line):
    """Log one page hit when the target carries a valid ref. Never raises."""
    try:
        ref = ref_from_target(target)
        path = hit_path(file_path, root)
        if not ref or not path:
            return False
        at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        save_line(data_dir.rstrip("/\\") + "/" + HITS_FILE, {"at": at, "ref": ref, "path": path})
        return True
    except Exception as e:
        import sys
        print("ref hit not logged:", type(e).__name__, file=sys.stderr)
        return False
