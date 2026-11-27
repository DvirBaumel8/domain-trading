"""HTTP for every outside request: SSRF guard checked at each redirect hop, platform deny-list, politeness, size caps.

Error messages never contain a URL query string (it may be signed) or a key.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from contextlib import asynccontextmanager
from urllib.parse import urljoin, urlsplit

import httpx

from . import config
from .polite import HostLimiter

# httpx logs every request URL at INFO; a URL may carry a signed query, so its logger stays at WARNING.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

# Test-only switch: lets the test process talk to its own loopback servers. It is a module attribute, off by default,
# never read from input or environment; only tests flip it (see tests/test_net.py).
_ALLOW_LOOPBACK_FOR_TESTS = False

DENY_HOSTS = {
    "youtube.com": "unsupported_platform", "youtu.be": "unsupported_platform", "spotify.com": "unsupported_platform",
    "soundcloud.com": "unsupported_platform", "tiktok.com": "unsupported_platform", "instagram.com": "unsupported_platform",
    "facebook.com": "unsupported_platform", "x.com": "unsupported_platform", "twitter.com": "unsupported_platform",
    "audible.com": "unsupported_platform", "music.apple.com": "unsupported_platform",
}
DENY_MESSAGES = {
    "spotify.com": "Spotify does not publish audio files. If the show also has a public RSS feed, paste that.",
    "youtube.com": "YouTube links are not supported. Paste the show's public RSS feed or a direct audio file URL.",
    "youtu.be": "YouTube links are not supported. Paste the show's public RSS feed or a direct audio file URL.",
}


class SourceError(Exception):
    """A stable error code plus a safe message (no URL query, no key)."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code, self.message = code, message or code


def safe_url(url: str) -> str:
    """The URL without query string or fragment, for messages and logs."""
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}{p.path}"


def denied(url: str) -> SourceError | None:
    p = urlsplit(url)
    host = (p.hostname or "").lower().rstrip(".")
    if p.path.lower().endswith(".m3u8"):
        return SourceError("unsupported_stream", "Streaming playlists (.m3u8) are not supported. Paste a direct audio file URL.")
    for d, code in DENY_HOSTS.items():
        if host == d or host.endswith("." + d):
            return SourceError(code, DENY_MESSAGES.get(d, f"{d} links are not supported. Paste a public RSS feed or a direct audio file URL."))
    return None


def ip_blocked(ip: str) -> bool:
    a = ipaddress.ip_address(ip)
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    if _ALLOW_LOOPBACK_FOR_TESTS and a.is_loopback:
        return False
    return (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified
            or (isinstance(a, ipaddress.IPv6Address) and a in ipaddress.ip_network("fc00::/7")))


async def system_resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


class Net:
    def __init__(self, client: httpx.AsyncClient, *, resolver=system_resolve, sleep=asyncio.sleep, clock=time.monotonic,
                 interval: float = config.HOST_INTERVAL, downloads_per_host: int = config.DOWNLOADS_PER_HOST):
        self.client, self.resolver, self.sleep, self.clock = client, resolver, sleep, clock
        self.limiter = HostLimiter(interval, clock=clock, sleep=sleep)
        self._dl: dict[str, asyncio.Semaphore] = {}
        self._dl_n = downloads_per_host
        self.apple = AppleLimiter(clock=clock, sleep=sleep)

    def download_slot(self, url: str) -> asyncio.Semaphore:
        host = (urlsplit(url).hostname or "").lower()
        return self._dl.setdefault(host, asyncio.Semaphore(self._dl_n))

    async def check(self, url: str) -> None:
        p = urlsplit(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise SourceError("invalid_input", "Only http and https URLs are supported.")
        d = denied(url)
        if d:
            raise d
        host = p.hostname.strip("[]")
        try:
            ips = [str(ipaddress.ip_address(host))]
        except ValueError:
            if host.lower() == "localhost" or host.lower().endswith(".localhost"):
                if not _ALLOW_LOOPBACK_FOR_TESTS:
                    raise SourceError("ssrf_blocked", "Private or local addresses are not allowed.") from None
            try:
                ips = await self.resolver(host)
            except OSError:
                raise SourceError("host_not_found", f"Host not found: {p.hostname}") from None
        if not ips or any(ip_blocked(ip) for ip in ips):
            raise SourceError("ssrf_blocked", "Private or local addresses are not allowed.")

    @asynccontextmanager
    async def stream(self, url: str, *, headers: dict | None = None, timeout: float | None = 30.0, retries: int = 3,
                     auth_retries: int = 1):
        """GET with manual redirects (each hop checked), polite pacing and backoff. Yields the final response (streaming)."""
        hops, attempt, auth_attempt = 0, 0, 0
        while True:
            await self.check(url)
            await self.limiter.wait(url)
            req = self.client.build_request("GET", url, headers=headers, timeout=timeout)
            try:
                r = await self.client.send(req, stream=True, follow_redirects=False)
            except httpx.TimeoutException:
                if attempt < retries - 1:
                    attempt += 1
                    await self.sleep(min(2.0 ** attempt, 30.0))
                    continue
                raise SourceError("timeout", f"Timed out: {safe_url(url)}") from None
            except httpx.HTTPError as e:
                if attempt < retries - 1:
                    attempt += 1
                    await self.sleep(min(2.0 ** attempt, 30.0))
                    continue
                raise SourceError("connection_failed", f"Connection failed ({type(e).__name__}): {safe_url(url)}") from None
            if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                await r.aclose()
                hops += 1
                if hops > config.MAX_REDIRECTS:
                    raise SourceError("too_many_redirects", "More than 5 redirects.")
                url = urljoin(url, r.headers["location"])
                continue
            if r.status_code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                attempt += 1
                wait = _retry_after(r, attempt)
                await r.aclose()
                await self.sleep(wait)
                continue
            if r.status_code in (401, 403) and auth_attempt < auth_retries:
                auth_attempt += 1
                await r.aclose()
                await self.sleep(1.0)
                continue
            try:
                r.final_url = url  # type: ignore[attr-defined]
                yield r
            finally:
                await r.aclose()
            return

    async def get_bytes(self, url: str, cap: int, *, too_large: str = "too_large", **kw) -> tuple[httpx.Response, bytes]:
        async with self.stream(url, **kw) as r:
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > cap:
                    raise SourceError(too_large, "The response is larger than the limit.")
            return r, bytes(buf)


def _retry_after(r: httpx.Response, attempt: int) -> float:
    try:
        return min(float(r.headers.get("retry-after", "")), 30.0)
    except ValueError:
        return min(2.0 ** attempt, 30.0)


class AppleLimiter:
    """At most 20 iTunes lookups in any 60-second window."""

    def __init__(self, per_minute: int = config.APPLE_LOOKUPS_PER_MINUTE, clock=time.monotonic, sleep=asyncio.sleep):
        self.per_minute, self.clock, self.sleep = per_minute, clock, sleep
        self.times: list[float] = []
        self.lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self.lock:
            while True:
                now = self.clock()
                self.times = [t for t in self.times if now - t < 60.0]
                if len(self.times) < self.per_minute:
                    self.times.append(now)
                    return
                await self.sleep(60.0 - (now - self.times[0]) + 0.01)
