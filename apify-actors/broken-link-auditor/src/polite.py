"""Polite HTTP: a per-host rate limit, backoff on 429/5xx, no secrets in errors.

Copied into each actor's src/ (the actor Docker build only sees its own folder). A test keeps the copies identical.
"""
from __future__ import annotations

import asyncio
import time
from urllib.parse import urlsplit

import httpx

RETRY_STATUS = (429, 500, 502, 503, 504)
MAX_RETRY_AFTER = 30.0


class FetchError(Exception):
    """A request failed after retries. The message never contains the URL (it may carry a key)."""


class HostLimiter:
    """At most one request per `min_interval` seconds to each host."""

    def __init__(self, min_interval: float = 1.0, clock=time.monotonic, sleep=asyncio.sleep):
        self.min_interval, self._clock, self._sleep = min_interval, clock, sleep
        self._next: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait(self, url: str) -> None:
        host = urlsplit(url).netloc.lower()
        async with self._lock:
            now = self._clock()
            at = max(now, self._next.get(host, 0.0))
            self._next[host] = at + self.min_interval
        if at > now:
            await self._sleep(at - now)


def _retry_after(r: httpx.Response, attempt: int) -> float:
    try:
        return min(float(r.headers.get("retry-after", "")), MAX_RETRY_AFTER)
    except ValueError:
        return min(2.0 ** (attempt + 1), MAX_RETRY_AFTER)


async def request(client: httpx.AsyncClient, method: str, url: str, *, limiter: HostLimiter | None = None,
                  retries: int = 3, sleep=asyncio.sleep, **kw) -> httpx.Response:
    """Returns the last response (which may still be 429/5xx after `retries`). Raises FetchError on transport errors."""
    last_err = "request failed"
    for attempt in range(retries + 1):
        if limiter:
            await limiter.wait(url)
        try:
            r = await client.request(method, url, **kw)
        except httpx.TimeoutException:
            last_err = "timeout"
        except httpx.HTTPError as e:
            last_err = type(e).__name__
        else:
            if r.status_code not in RETRY_STATUS or attempt == retries:
                return r
            await sleep(_retry_after(r, attempt))
            continue
        if attempt < retries:
            await sleep(min(2.0 ** (attempt + 1), MAX_RETRY_AFTER))
    raise FetchError(last_err)
