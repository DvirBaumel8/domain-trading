"""The run loop, free of the Apify SDK so tests can drive it: push(row, charge) decides what is charged."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx

from . import core
from .polite import FetchError, HostLimiter, request

UA = "WaybackDomainHistory/0.1 (Apify actor; polite, ~1 request/second)"
MAX_PAGES = 200


def chargeable(row: dict) -> bool:
    """Only ok rows and a valid empty history are charged. Errors never."""
    return row.get("status") in ("ok", "no_snapshots")


async def _get_json(client, url, params, limiter, sleep):
    r = await request(client, "GET", url, params=params, limiter=limiter, sleep=sleep)
    if r.status_code != 200:
        raise FetchError(f"archive.org answered HTTP {r.status_code}")
    try:
        return r.json()
    except ValueError:
        raise FetchError("archive.org sent an invalid answer") from None


async def fetch_rows(client, domain, inp, limiter, sleep):
    rows, key = [], None
    for _ in range(MAX_PAGES):
        params = core.cdx_params(domain, bool(inp.get("includeSubdomains")), inp.get("fromYear"), inp.get("toYear"), key)
        try:
            page, key = core.parse_cdx_page(await _get_json(client, core.CDX_URL, params, limiter, sleep))
        except ValueError as e:
            raise FetchError(str(e)) from None
        rows += page
        if not key:
            break
    return rows


async def check_domain(client, domain, inp, limiter, sleep) -> dict:
    row = {"domain": domain, "status": "ok", "error": None}
    rows = await fetch_rows(client, domain, inp, limiter, sleep)
    if not rows and not (inp.get("fromYear") or inp.get("toYear")):
        # Second opinion from the availability API before saying "no captures".
        data = await _get_json(client, core.AVAILABLE_URL, {"url": domain}, limiter, sleep)
        url = core.parse_available(data)
        if url:
            ts = url.split("/web/")[1].split("/")[0] if "/web/" in url else ""
            if len(ts) >= 8 and ts[:8].isdigit():
                rows = [(ts, "200", domain)]
    stats = core.analyse(rows, int(inp.get("sampleSnapshots") or 1))
    row.update(core.public_row(stats))
    row["summary"] = core.summarize(stats)
    if not rows:
        row["status"] = "no_snapshots"
    return row


async def run(inp: dict, *, client, push, set_status, sleep=asyncio.sleep, limiter=None, per_domain_timeout=300.0) -> tuple[bool, str]:
    inp = inp or {}
    domains, invalid = [], 0
    for raw in inp.get("domains") or []:
        d = core.clean_domain(raw)
        if d:
            domains.append(d)
        else:
            invalid += 1  # not pushed, not charged
    domains = list(dict.fromkeys(domains))
    if not domains:
        return False, "Add at least one valid domain in the Domains field."
    limiter = limiter or HostLimiter(1.0)
    done = errors = 0
    for d in domains:
        try:
            row = await asyncio.wait_for(check_domain(client, d, inp, limiter, sleep), per_domain_timeout)
        except (FetchError, asyncio.TimeoutError) as e:
            reason = "timeout" if isinstance(e, asyncio.TimeoutError) else str(e)
            row = {"domain": d, "status": "error", "error": reason, "totalSnapshots": 0, "summary": f"Could not read the archive: {reason}"}
            errors += 1
        row["checkedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        done += 1
        if await push(row, chargeable(row)):
            return True, f"Spending limit reached after {done} domains."
        await set_status(f"Checked {done}/{len(domains)}")
    msg = f"Done: {done} domains ({errors} errors, not charged; {invalid} invalid inputs skipped)."
    return True, msg
