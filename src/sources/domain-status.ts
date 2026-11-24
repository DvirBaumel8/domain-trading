// What the registrar says today about each domain we own: expiry, auto-renew, nameservers, transfer lock. Reads only.
import { z } from 'zod';
import type { Domain } from '../state.js';
import { readJson, SourceError, type Fetch } from './client.js';

export interface DomainStatus { expiryDate: string; autoRenew: boolean; locked: boolean; nameservers: string[] }
export interface DomainStatusRow { domain: string; registrar: string; status: DomainStatus | null; error: SourceError | null }
export interface DomainStatusKeys { porkbun: { apiKey: string; secretKey: string } | null; godaddyPat: string | null }

const host = z.string().min(1);
const day = (source: string, v: string): string => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(v)?.[1];
  if (!d) throw new SourceError(source, 'BAD_RESPONSE', 200);
  return d;
};
const sorted = (ns: string[]): string[] => ns.map((x) => x.toLowerCase()).sort();

const flag = z.union([z.literal(0), z.literal(1), z.literal('0'), z.literal('1')]).transform((v) => Number(v) === 1);
const PorkbunDomain = z.object({ status: z.literal('SUCCESS'), domain: z.object({ domain: z.string(), expireDate: z.string(), autoRenew: flag, securityLock: flag }) });
const PorkbunNs = z.object({ status: z.literal('SUCCESS'), ns: z.array(host).min(1) });

async function porkbun(domain: string, keys: DomainStatusKeys['porkbun'], fetchFn: Fetch): Promise<DomainStatus> {
  const source = 'porkbun';
  if (!keys) throw new SourceError(source, 'KEY_MISSING');
  const get = (op: string) => readJson(fetchFn, { source, url: `https://api.porkbun.com/api/json/v3/domain/${op}/${encodeURIComponent(domain)}`, headers: { 'x-api-key': keys.apiKey, 'x-secret-api-key': keys.secretKey } });
  const [d, ns] = await Promise.all([get('get'), get('getNs')]);
  const info = PorkbunDomain.safeParse(d);
  const servers = PorkbunNs.safeParse(ns);
  if (!info.success || !servers.success || info.data.domain.domain.toLowerCase() !== domain) throw new SourceError(source, 'BAD_RESPONSE', 200);
  return { expiryDate: day(source, info.data.domain.expireDate), autoRenew: info.data.domain.autoRenew, locked: info.data.domain.securityLock, nameservers: sorted(servers.data.ns) };
}

const GodaddyList = z.object({
  items: z.array(z.object({ domain: z.string(), expiresAt: z.string(), autoRenew: z.boolean(), transferLock: z.boolean(), nameServers: z.array(host).min(1) }).partial({ expiresAt: true, autoRenew: true, transferLock: true, nameServers: true })),
  links: z.array(z.object({ rel: z.string() })).default([]),
});

async function godaddyList(pat: string | null, fetchFn: Fetch): Promise<(domain: string) => DomainStatus> {
  const source = 'godaddy';
  if (!pat) throw new SourceError(source, 'KEY_MISSING');
  const parsed = GodaddyList.safeParse(await readJson(fetchFn, { source, url: 'https://api.godaddy.com/v3/domains/domain-names?pageSize=200', headers: { authorization: `Bearer ${pat}` } }));
  if (!parsed.success) throw new SourceError(source, 'BAD_RESPONSE', 200);
  const more = parsed.data.links.some((l) => l.rel === 'next');
  return (domain) => {
    const d = parsed.data.items.find((x) => x.domain.toLowerCase() === domain);
    if (!d) throw new SourceError(source, more ? 'BAD_RESPONSE' : 'NOT_IN_ACCOUNT', 200); // a cut list proves nothing
    if (d.expiresAt === undefined || d.autoRenew === undefined || d.transferLock === undefined || d.nameServers === undefined) throw new SourceError(source, 'BAD_RESPONSE', 200);
    return { expiryDate: day(source, d.expiresAt), autoRenew: d.autoRenew, locked: d.transferLock, nameservers: sorted(d.nameServers) };
  };
}

const asError = (source: string, e: unknown): SourceError => (e instanceof SourceError ? e : new SourceError(source, 'BAD_RESPONSE'));

/** One row for every owned domain. A failure is in its row, never a missing row. */
export async function domainStatuses(domains: readonly Domain[], keys: DomainStatusKeys, fetchFn: Fetch = fetch): Promise<DomainStatusRow[]> {
  const owned = domains.filter((d) => d.status === 'owned');
  const list = owned.some((d) => d.registrar === 'godaddy') ? godaddyList(keys.godaddyPat, fetchFn) : null;
  list?.catch(() => {}); // each row awaits it and reports its failure
  return Promise.all(owned.map(async ({ domain, registrar }) => {
    try {
      if (registrar === 'porkbun') return { domain, registrar, status: await porkbun(domain, keys.porkbun, fetchFn), error: null };
      if (registrar === 'godaddy') return { domain, registrar, status: (await list!)(domain), error: null };
      throw new SourceError(registrar, 'KEY_MISSING');
    } catch (e) {
      return { domain, registrar, status: null, error: asError(registrar, e) };
    }
  }));
}
