"""Weekly referral counts. python3 site/ref_counts.py [--days N] [--data-dir D] [--store-dir D]
Read-only, local files only (no network, no GitHub calls). Page hits: <data-dir>/ref-hits.jsonl. Free-check requests and
orders: leads/*.json and orders/*.json of the private orders store (--store-dir; default ORDERS_LOCAL_DIR, else
../private-orders, the same default as the server). Prints only refs and counts: never emails, names, businesses,
cities, tokens or IPs."""
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


def _count_hits(path, since):
    out = {}
    for o in _lines(path):
        t = _parse(o.get("at"))
        if t is None or t < since:
            continue
        r = clean_ref(o.get("ref", ""))
        out[r] = out.get(r, 0) + 1
    return out


def _records(folder):
    """(file name, record dict) for every readable *.json in folder; bad files are skipped."""
    for f in sorted(glob.glob(os.path.join(folder, "*.json"))):
        try:
            with open(f, encoding="utf-8") as fh:
                o = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(o, dict):
            yield os.path.basename(f), o


def _utc(d):
    return d.replace(tzinfo=datetime.timezone.utc)


def _lead_time(name, o):
    """Lead time: the yymmdd-HHMMSS stamp in the file name, else the record's own `at`."""
    m = re.match(r"(\d{6}-\d{6})-", name)
    if m:
        try:
            return _utc(datetime.datetime.strptime(m.group(1), "%y%m%d-%H%M%S"))
        except ValueError:
            pass
    return _parse(o.get("at")) if o.get("at") else None


def _order_time(name, o):
    """Order time: `created_at` if present, else the day in the ORD-yymmdd id (the whole day counts)."""
    if o.get("created_at"):
        t = _parse(o.get("created_at"))
        if t is not None:
            return t
    m = re.match(r"ORD-(\d{6})-", name)
    try:
        d = _utc(datetime.datetime.strptime(m.group(1), "%y%m%d")) if m else None
    except ValueError:
        d = None
    return d + datetime.timedelta(days=1) - datetime.timedelta(seconds=1) if d else None


def _count_store(folder, since, when):
    """{ref: n} of the records in `folder` dated since `since`, or None if the folder does not exist."""
    if not folder or not os.path.isdir(folder):
        return None
    out = {}
    for name, o in _records(folder):
        t = when(name, o)
        if t is None or t < since:
            continue
        r = clean_ref(o.get("ref", ""))
        out[r] = out.get(r, 0) + 1
    return out


def collect(data_dir, store_dir, days=7, now=None):
    """-> {"rows": [(ref, hits|None, leads|None, orders|None)], "hits_available", "leads_available", "orders_available"}.
    Page hits: <data_dir>/ref-hits.jsonl. Free-check requests: <store_dir>/leads/*.json. Orders: <store_dir>/orders/*.json.
    A column whose source is missing is None (printed n/a)."""
    since = (now or _now()) - datetime.timedelta(days=days)
    hits_file = os.path.join(data_dir, HITS_FILE) if data_dir else ""
    hits = _count_hits(hits_file, since) if hits_file and os.path.isfile(hits_file) else None
    leads = _count_store(os.path.join(store_dir, "leads") if store_dir else "", since, _lead_time)
    orders = _count_store(os.path.join(store_dir, "orders") if store_dir else "", since, _order_time)
    cols = (hits, leads, orders)
    refs = set().union(*[set(c) for c in cols if c])
    rows = [(r or NONE, *[None if c is None else c.get(r, 0) for c in cols]) for r in refs]
    rows.sort(key=lambda x: (x[0] == NONE, -sum(v or 0 for v in x[1:]), x[0]))
    return {"rows": rows, "hits_available": hits is not None, "leads_available": leads is not None,
            "orders_available": orders is not None}


def format_table(result, days=7):
    head = ("ref", "page hits", "free-check requests", "orders")
    na = lambda v: "n/a" if v is None else str(v)
    body = [(r, na(h), na(q), na(o)) for r, h, q, o in result["rows"]]
    w = [max(len(x[i]) for x in [head] + body) for i in range(4)]
    def fmt(c):
        return "  ".join([c[0].ljust(w[0])] + [c[i].rjust(w[i]) for i in (1, 2, 3)])
    lines = [f"Referral counts, last {days} days (UTC)", fmt(head), "  ".join("-" * x for x in w)]
    lines += [fmt(b) for b in body] or ["(no records)"]
    if not (result["leads_available"] and result["orders_available"]):
        lines.append("Note: free-check requests and orders n/a: no leads/ or orders/ folder in the store dir. Clone or "
                     "sync the private orders repo into a folder and pass --store-dir <that folder>.")
    if not result["hits_available"]:
        lines.append("Note: page hits n/a: no ref-hits.jsonl in --data-dir (that file lives on the running server's disk).")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Weekly referral counts (read-only).")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--store-dir", default=os.environ.get("ORDERS_LOCAL_DIR") or os.path.join(HERE, "..", "private-orders"),
                    help="folder holding leads/ and orders/ (a clone or sync of the private orders repo)")
    a = ap.parse_args(argv)
    if not 1 <= a.days <= 90:
        ap.error("--days must be between 1 and 90")
    print(format_table(collect(a.data_dir, a.store_dir, a.days), a.days))
    return 0


if __name__ == "__main__":
    sys.exit(main())
