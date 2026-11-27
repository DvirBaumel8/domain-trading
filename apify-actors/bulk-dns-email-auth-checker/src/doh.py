"""DNS over HTTPS (Cloudflare JSON API, Google fallback). Portable: no UDP/53 needed."""
from __future__ import annotations
import asyncio
import httpx

DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
RCODE_NOERROR, RCODE_NXDOMAIN = 0, 3


class DohResolver:
    def __init__(self, client: httpx.AsyncClient, retries: int = 3):
        self.client = client
        self.retries = retries

    async def query(self, name: str, rtype: str) -> tuple[int | None, list[dict]]:
        """Return (rcode, answers) where answers are dicts {name,type,TTL,data}. rcode None = lookup failed."""
        for attempt in range(self.retries):
            ep = DOH_ENDPOINTS[attempt % len(DOH_ENDPOINTS)]
            try:
                r = await self.client.get(ep, params={'name': name, 'type': rtype},
                                          headers={'accept': 'application/dns-json'}, timeout=10)
                if r.status_code == 200:
                    j = r.json()
                    return j.get('Status'), j.get('Answer') or []
            except (httpx.HTTPError, ValueError):
                pass
            await asyncio.sleep(0.4 * (attempt + 1))
        return None, []

    async def records(self, name: str, rtype: str, type_code: int) -> tuple[int | None, list[str]]:
        rcode, ans = await self.query(name, rtype)
        return rcode, [a.get('data', '') for a in ans if a.get('type') == type_code]
