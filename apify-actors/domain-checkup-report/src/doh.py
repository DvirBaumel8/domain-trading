"""DNS over HTTPS (Cloudflare JSON API, Google fallback) + Cloudflare 1.1.1.2 Security DNS."""
from __future__ import annotations
import asyncio
import httpx

DOH_ENDPOINTS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']
SECURITY_DOH_ENDPOINT = 'https://security.cloudflare-dns.com/dns-query'
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
                r = await self.client.get(
                    ep,
                    params={'name': name, 'type': rtype},
                    headers={'accept': 'application/dns-json'},
                    timeout=10,
                )
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

    async def security_check(self, name: str) -> tuple[str, str, str | None]:
        """
        Query Cloudflare Security DNS (1.1.1.2) for malware/phishing filtering.
        Returns (safetyStatus, safetyDetail, safetySource).
        """
        for attempt in range(2):
            try:
                r = await self.client.get(
                    SECURITY_DOH_ENDPOINT,
                    params={'name': name, 'type': 'A'},
                    headers={'accept': 'application/dns-json'},
                    timeout=10,
                )
                if r.status_code == 200:
                    j = r.json()
                    status = j.get('Status')
                    ans = j.get('Answer') or []
                    comments = j.get('Comment') or []
                    blocked_ip = any(a.get('data') in ('0.0.0.0', '::') for a in ans if isinstance(a, dict))
                    blocked_ede = any('EDE(16)' in str(c) or 'Censored' in str(c) for c in comments)
                    if blocked_ip or blocked_ede:
                        return (
                            'flagged_malware_or_phishing',
                            'Blocked by Cloudflare Security DNS (1.1.1.2) as malware or phishing.',
                            'Cloudflare Security DNS (1.1.1.2)',
                        )
                    if status == RCODE_NXDOMAIN:
                        return (
                            'not_checked',
                            'Not checked (domain does not resolve in DNS / NXDOMAIN).',
                            None,
                        )
                    if status == RCODE_NOERROR:
                        return (
                            'not_flagged',
                            'Not flagged by Cloudflare Security DNS (1.1.1.2). Note: not a universal safety guarantee.',
                            'Cloudflare Security DNS (1.1.1.2)',
                        )
                    return (
                        'not_checked',
                        f'Not checked (DNS resolver returned status {status}).',
                        None,
                    )
            except (httpx.HTTPError, ValueError):
                pass
            await asyncio.sleep(0.3 * (attempt + 1))
        return ('not_checked', 'Not checked (Cloudflare Security DNS lookup failed).', None)
