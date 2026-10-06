// The one outbound guard for fetching third-party sites (CAP-12 operator pages, and CAP-15 lead firm pages later). Every request, including
// robots.txt, every redirect hop and the http fallback, goes through `safeFetch`:
//   - only http and https, only the default ports (URL.port is ''), never an IP-literal host (decimal, octal and hex forms are normalised
//     by the URL parser, so they arrive as dotted IPs and are refused too);
//   - hosts in `neverFetchHosts` (and their subdomains) are refused;
//   - the host is resolved HERE (dns lookup, all addresses); if any address is private, loopback, link-local, CGNAT, multicast,
//     reserved, documentation or an IPv6 form embedding one of those (mapped, compatible, NAT64, 6to4), the request is refused;
//   - the connection is made to the vetted address only (an undici Agent whose connect.lookup returns it), so a second DNS answer
//     (rebinding) is never used. TLS still uses the hostname for SNI and certificate checks.
import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

export type BlockCode = 'ADDRESS_BLOCKED' | 'HOST_EXCLUDED' | 'URL_NOT_ALLOWED';
export class BlockedError extends Error {
  constructor(readonly code: BlockCode, message: string) {
    super(message);
    this.name = 'BlockedError';
  }
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemLookup: LookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

// ---------- address classes ----------

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(s: string): number | null {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}
const blockedV4Int = (n: number): boolean => V4_BLOCKED.some(([base, bits]) => {
  const b = v4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
});

/** An IPv6 text form as a 128-bit number; null when it is not valid. */
function v6ToBig(input: string): bigint | null {
  let s = input.split('%')[0]!;
  if (!net.isIPv6(s)) return null;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) {
    const colon = s.lastIndexOf(':', dot);
    const v4 = v4ToInt(s.slice(colon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, colon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? h.length !== 8 : missing < 0) return null;
  const groups = [...h, ...(tail === undefined ? [] : Array(missing).fill('0')), ...t];
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g, 16));
  return n;
}
const inV6 = (n: bigint, base: bigint, bits: number): boolean => (n >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
const hex = (s: string) => BigInt(`0x${s}`);

/** True for an address a public site must never resolve to (see the file header). Unparseable text is blocked. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blockedV4Int(v4ToInt(ip)!);
  const n = v6ToBig(ip);
  if (n === null) return true;
  const low32 = Number(n & 0xffffffffn);
  if (n === 0n || n === 1n) return true; // :: and ::1
  if (inV6(n, 0n, 96)) return true; // ::/96, IPv4-compatible (deprecated) and the rest of the low block
  if (inV6(n, hex('ffff00000000'), 96)) return blockedV4Int(low32); // ::ffff:0:0/96 IPv4-mapped
  if (inV6(n, hex('0064ff9b') << 96n, 96)) return blockedV4Int(low32); // 64:ff9b::/96 NAT64
  if (inV6(n, hex('0064ff9b0001') << 80n, 48)) return true; // 64:ff9b:1::/48 local-use NAT64
  if (inV6(n, hex('2002') << 112n, 16)) return blockedV4Int(Number((n >> 80n) & 0xffffffffn)); // 2002::/16 6to4 embeds a v4
  if (inV6(n, hex('20010000') << 96n, 32)) return true; // 2001::/32 Teredo
  if (inV6(n, hex('20010db8') << 96n, 32)) return true; // documentation
  if (inV6(n, hex('200100020000') << 80n, 48)) return true; // benchmarking
  if (inV6(n, hex('0100') << 112n, 64)) return true; // 100::/64 discard
  if (inV6(n, hex('fe80') << 112n, 10)) return true; // link-local
  if (inV6(n, hex('fec0') << 112n, 10)) return true; // deprecated site-local
  if (inV6(n, hex('fc00') << 112n, 7)) return true; // unique local
  if (inV6(n, hex('ff00') << 112n, 8)) return true; // multicast
  return false;
}

/** The connect.lookup of the vetted Agent: always answers with the vetted addresses, whatever the name (so DNS is never asked again). */
export function vettedLookup(addresses: { address: string; family: number }[]) {
  return (_hostname: string, options: { all?: boolean } | undefined, cb: (err: Error | null, address: unknown, family?: number) => void): void => {
    if (options?.all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, addresses[0]!.address, addresses[0]!.family);
  };
}

// ---------- the guard ----------

export const hostExcluded = (host: string, neverFetchHosts: string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return neverFetchHosts.some((x) => { const e = x.toLowerCase().replace(/^\./, ''); return h === e || h.endsWith(`.${e}`); });
};

export interface SafeFetchDeps { fetch: typeof fetch; lookupHost?: LookupAll }
export interface SafeFetchOpts { neverFetchHosts?: string[] }

/** Throws BlockedError for a URL the guard refuses before any connection is made; a lookup failure is rethrown with its code (ENOTFOUND etc.) as the cause. */
export async function vetUrl(rawUrl: string, lookupHost: LookupAll, o: SafeFetchOpts): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new BlockedError('URL_NOT_ALLOWED', 'not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedError('URL_NOT_ALLOWED', `scheme ${url.protocol} is not allowed`);
  if (url.port !== '') throw new BlockedError('URL_NOT_ALLOWED', 'only the default ports 80 and 443 are allowed');
  if (url.username !== '' || url.password !== '') throw new BlockedError('URL_NOT_ALLOWED', 'credentials in a URL are not allowed');
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || net.isIP(host) !== 0) throw new BlockedError('ADDRESS_BLOCKED', 'IP-literal hosts are not fetched');
  if (hostExcluded(host, o.neverFetchHosts ?? [])) throw new BlockedError('HOST_EXCLUDED', `${host} is on the never-fetch list`);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupHost(host);
  } catch (e) {
    throw Object.assign(new TypeError('fetch failed'), { cause: e });
  }
  if (addresses.length === 0) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('no address'), { code: 'ENOTFOUND' }) });
  if (addresses.some((a) => isBlockedAddress(a.address))) throw new BlockedError('ADDRESS_BLOCKED', `${host} resolves to a blocked address`);
  return { url, addresses };
}

/** One guarded request: vet the URL and the resolved addresses, then connect to the vetted address only. `init.redirect` is the caller's (redirects are followed by hand, each hop through here). */
export async function safeFetch(deps: SafeFetchDeps, rawUrl: string, init: RequestInit, o: SafeFetchOpts = {}): Promise<Response> {
  const { url, addresses } = await vetUrl(rawUrl, deps.lookupHost ?? systemLookup, o);
  const dispatcher = new Agent({ connections: 1, keepAliveTimeout: 100, keepAliveMaxTimeout: 100, connect: { lookup: vettedLookup(addresses) as never } });
  try {
    return await deps.fetch(url.toString(), { ...init, dispatcher } as RequestInit);
  } catch (e) {
    void dispatcher.close().catch(() => {});
    throw e;
  }
}
