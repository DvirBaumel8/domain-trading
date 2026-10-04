export type RdapStatus = 'not_registered' | 'registered' | 'rdap_unknown';
export type RdapFn = (domain: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<RdapStatus>;

const RDAP_COM = 'https://rdap.verisign.com/com/v1/domain/';

export const rdapStatus: RdapFn = async (domain, opts = {}) => {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await fetch(`${RDAP_COM}${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json' }, signal });
    void res.body?.cancel().catch(() => {}); // do not await: can hang on some bodies
    if (res.status === 404) return 'not_registered';
    if (res.status === 200) return 'registered';
    return 'rdap_unknown';
  } catch {
    return 'rdap_unknown';
  }
};
