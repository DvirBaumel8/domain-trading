export type RdapStatus = 'not_registered' | 'registered' | 'rdap_unknown';
export type RdapFn = (domain: string, opts?: { timeoutMs?: number }) => Promise<RdapStatus>;

const USER_AGENT = 'domain-trading-api';

/** Asks the .com registry about one name. Never throws. Only a clear registry answer counts; a proxy or error page is `rdap_unknown`. */
export const rdapStatus: RdapFn = async (domain, opts = {}) => {
  try {
    const res = await fetch(`https://rdap.verisign.com/com/v1/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {}); // not awaited: some servers never finish the body
      return res.status === 404 && /application\/(rdap\+)?json/i.test(res.headers.get('content-type') ?? '') ? 'not_registered' : 'rdap_unknown';
    }
    const body = (await res.json()) as { objectClassName?: unknown; ldhName?: unknown } | null;
    const same = typeof body?.ldhName === 'string' && body.ldhName.toLowerCase().replace(/\.$/, '') === domain.toLowerCase();
    return same && (body!.objectClassName === undefined || body!.objectClassName === 'domain') ? 'registered' : 'rdap_unknown';
  } catch {
    return 'rdap_unknown';
  }
};
