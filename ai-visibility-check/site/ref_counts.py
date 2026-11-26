"""Weekly referral counts. python3 site/ref_counts.py [--days N] [--data-dir D] [--orders-dir D]
Read-only. Prints only refs and counts (no emails, names, cities, tokens or IPs). No network."""
import argparse, datetime, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from refs import clean_ref, HITS_FILE  # noqa: E402

NONE = "(none)"


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _parse(ts):
    try:
        d = datetime.datetime.fromisoformat(str(ts))
    except (ValueError, TypeError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def _lines(path):
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict):
                yield o


def _count(path, since, key="at"):
    out = {}
    for o in _lines(path):
        t = _parse(o.get(key))
        if t is None or t < since:
            continue
        r = clean_ref(o.get("ref", ""))
        out[r] = out.get(r, 0) + 1
    return out


def order_files(orders_dir):
    return sorted(glob.glob(os.path.join(orders_dir, "orders", "ORD-*.json")))


def count_orders(orders_dir, since):
    """{ref: n} for orders created since `since`, or None if there is no local orders folder."""
    files = order_files(orders_dir) if orders_dir else []
    if not files:
        return None
    out = {}
    for f in files:
        try:
            with open(f, encoding="utf-8") as fh:
                o = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(o, dict):
            continue
        t = _parse(o.get("created_at")) if o.get("created_at") else None
        if t is None:
            m = re.match(r"ORD-(\d{6})-", os.path.basename(f))
            try:
                t = datetime.datetime.strptime(m.group(1), "%y%m%d").replace(tzinfo=datetime.timezone.utc) if m else None
            except ValueError:
                t = None
            if t is not None:           # id carries the day only: count the whole day
                t = t + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)
        if t is None or t < since:
            continue
        r = clean_ref(o.get("ref", ""))
        out[r] = out.get(r, 0) + 1
    return out


def collect(data_dir, orders_dir, days=7, now=None):
    """-> {"rows": [(ref, hits, requests, orders|None)], "orders_available": bool}"""
    since = (now or _now()) - datetime.timedelta(days=days)
    hits = _count(os.path.join(data_dir, HITS_FILE), since)
    reqs = _count(os.path.join(data_dir, "requests.jsonl"), since)
    orders = count_orders(orders_dir, since)
    refs = set(hits) | set(reqs) | set(orders or {})
    rows = [(r or NONE, hits.get(r, 0), reqs.get(r, 0), None if orders is None else orders.get(r, 0)) for r in refs]
    rows.sort(key=lambda x: (x[0] == NONE, -(x[1] + x[2] + (x[3] or 0)), x[0]))
    return {"rows": rows, "orders_available": orders is not None}


def format_table(result, days=7):
    head = ("ref", "page hits", "free-check requests", "orders")
    body = [(r, str(h), str(q), "n/a" if o is None else str(o)) for r, h, q, o in result["rows"]]
    w = [max(len(x[i]) for x in [head] + body) for i in range(4)]
    def fmt(c):
        return "  ".join([c[0].ljust(w[0])] + [c[i].rjust(w[i]) for i in (1, 2, 3)])
    lines = [f"Referral counts, last {days} days (UTC)", fmt(head), "  ".join("-" * x for x in w)]
    lines += [fmt(b) for b in body] or ["(no records)"]
    if not result["orders_available"]:
        lines.append("Note: orders n/a: no local orders folder found (production orders are in the private "
                     "GitHub store). Check it out locally and pass --orders-dir <folder with orders/>.")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Weekly referral counts (read-only).")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--orders-dir", default=os.environ.get("ORDERS_LOCAL_DIR") or os.path.join(HERE, "..", "private-orders"))
    a = ap.parse_args(argv)
    if not 1 <= a.days <= 90:
        ap.error("--days must be between 1 and 90")
    print(format_table(collect(a.data_dir, a.orders_dir, a.days), a.days))
    return 0


if __name__ == "__main__":
    sys.exit(main())
