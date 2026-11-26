"""The run loop without the Apify SDK: push(row, charge) decides what is charged. Never logs the key."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from . import core
from .polite import FetchError, HostLimiter, request

UA = "BulkPageSpeedChecker/0.1 (Apify actor; polite)"
INTERVAL, CONCURRENCY = 0.5, 3
KEY_MISSING = "Add your Google PageSpeed Insights API key in the API key field. The actor needs it to run."
QUOTA_MSG = "Quota exceeded for this API key"
HTTP_REASONS = {400: "Bad API key or bad URL", 403: "PageSpeed Insights API is not enabled for this API key",
                429: QUOTA_MSG}


class QuotaExceeded(ValueError):
    pass


def silence_http_logs() -> None:
    """httpx logs every request URL at INFO, and the URL carries the key. Keep these loggers quiet."""
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def chargeable(row: dict) -> bool:
    return row.get("status") == "ok"


async def check_one(client, url, strategy, categories, key, limiter, sleep) -> tuple[dict, bool]:
    """Returns (row, quota_exceeded)."""
    row = {"url": url, "strategy": strategy, "status": "ok", "error": None}
    quota = False
    try:
        r = await request(client, "GET", core.API_URL, params=core.request_params(url, strategy, categories, key),
                          limiter=limiter, sleep=sleep, timeout=120)
        if r.status_code != 200:
            if r.status_code == 429:
                raise QuotaExceeded(QUOTA_MSG)
            raise ValueError(HTTP_REASONS.get(r.status_code) or f"PageSpeed API answered HTTP {r.status_code}")
        try:
            data = r.json()
        except ValueError:
            raise ValueError("PageSpeed API sent an invalid answer") from None
        row.update(core.parse_result(data, categories))
    except (FetchError, ValueError) as e:  # messages never include the URL or the key
        quota = isinstance(e, QuotaExceeded)
        row.update(status="error", error=str(e), scores={}, labMetrics={}, fieldDataPresent=False, fieldData=None, originFieldData=None)
    row["checkedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return row, quota


async def run(inp: dict, *, client, push, set_status, sleep=asyncio.sleep, limiter=None) -> tuple[bool, str]:
    silence_http_logs()
    inp = inp or {}
    urls, invalid = [], 0
    for raw in inp.get("urls") or []:
        u = core.normalize_url(raw)
        if u:
            urls.append(u)
        else:
            invalid += 1
    urls = list(dict.fromkeys(urls))
    if not urls:
        return False, "Add at least one valid URL in the URLs field."
    strategies = core.pick(inp.get("strategies"), ("mobile", "desktop"), ("mobile", "desktop"))
    categories = core.pick(inp.get("categories"), tuple(core.CATEGORY_PARAM), ("performance",))
    key = (inp.get("apiKey") or "").strip()
    if not key:
        return False, KEY_MISSING
    limiter = limiter or HostLimiter(INTERVAL)
    sem = asyncio.Semaphore(CONCURRENCY)
    await set_status(f"Testing {len(urls) * len(strategies)} pages with your API key at a bounded rate.")
    state = {"done": 0, "errors": 0, "stop": False, "quota": False}

    async def one(url, strategy):
        async with sem:
            if state["stop"]:
                return
            row, quota = await check_one(client, url, strategy, categories, key, limiter, sleep)
            if quota:
                state["quota"] = state["stop"] = True
            state["done"] += 1
            state["errors"] += row["status"] != "ok"
            if await push(row, chargeable(row)):
                state["stop"] = True
    await asyncio.gather(*(one(u, s) for u in urls for s in strategies))
    if state["quota"]:
        msg = f"Stopped: {QUOTA_MSG} (Google answered 429). {state['done'] - state['errors']} tests finished before it. Check your quota in Google Cloud, then run again."
        return state["done"] > state["errors"], msg
    return True, f"Done: {state['done']} tests ({state['errors']} errors, not charged; {invalid} invalid URLs skipped)."
