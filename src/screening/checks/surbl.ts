// G4 SURBL (CAP-05, SURBL-1): `<domain>.<zone>` A lookups sent straight to the zone's own authoritative servers (public resolvers
// are refused, DR-001). A control name that must be listed is asked once per run: if it is not answered as listed, nothing this run
// says about SURBL is trusted (every name UNKNOWN CONTROL_FAILED), so "not listed" can never come from a broken path.
import { Pacer } from '../rdap-batch.js';
import { storeEvidence } from '../evidence.js';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check, type CheckContext, type CheckOutcome } from '../types.js';

type SurblSettings = SelectionValuesT['surbl'];
interface Control { ok: boolean; servers: string[]; server: string | null; detail: string; evidenceId: number | null; next: number }

const MIN_MS_BETWEEN = 200; // <= 5 queries/s in total (sources.md)

const isIPv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** Decodes the last octet of a 127.0.0.x answer with the settings' list_bits. */
export function decodeBits(lastOctet: number, listBits: Record<string, string>): string[] {
  return Object.entries(listBits).filter(([bit]) => (lastOctet & Number(bit)) !== 0).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, name]) => name);
}

const hostsToIps = async (ctx: CheckContext, hosts: string[]): Promise<string[]> => {
  const ips: string[] = [];
  for (const h of hosts) {
    if (isIPv4(h)) { if (!ips.includes(h)) ips.push(h); continue; }
    for (const ip of await ctx.deps.resolve4(h.replace(/\.$/, '')).catch(() => [] as string[])) if (!ips.includes(ip)) ips.push(ip);
  }
  return ips;
};

/**
 * Candidate groups of authoritative server IPs, in the order they are tried until one answers the control as listed:
 * the settings' `ns_override`; else the zone's own NS records; else SURBL's documented query hosts a..j.<parent of the zone>
 * (sources.md: `multi.surbl.org` has no NS records of its own, a..j.surbl.org serve it; the NS of `surbl.org` do not).
 */
async function serverGroups(ctx: CheckContext, s: SurblSettings): Promise<string[][]> {
  const groups: string[][] = [];
  const add = (ips: string[]) => { if (ips.length > 0 && !groups.some((g) => g.join() === ips.join())) groups.push(ips); };
  if (s.ns_override.length > 0) { add(await hostsToIps(ctx, s.ns_override)); return groups; }
  add(await hostsToIps(ctx, await ctx.deps.resolveNs(s.zone).catch(() => [] as string[])));
  const parent = s.zone.split('.').slice(1).join('.');
  if (parent.includes('.')) add(await hostsToIps(ctx, 'abcdefghij'.split('').map((l) => `${l}.${parent}`)));
  return groups;
}

async function ask(ctx: CheckContext, pace: Pacer, s: SurblSettings, servers: string[], start: number, qname: string) {
  for (let i = 0; i < servers.length; i++) {
    const server = servers[(start + i) % servers.length]!;
    const ans = await pace.run(() => ctx.deps.dnsQuery(qname, 1, { server, timeoutMs: s.timeout_ms }));
    if (ans) return { server, ans };
  }
  return null;
}

const answerText = (qname: string, server: string, a: { rcode: number; answers: { type: number; data: string }[] }) =>
  `;; ${qname} A @${server}\n;; rcode ${a.rcode}\n${a.answers.map((x) => `${qname} A ${x.data}`).join('\n')}`.trim();

/** The control lookup, once per run: the first server group whose answer to the control name is "listed" is the one used. */
async function control(ctx: CheckContext, s: SurblSettings, pace: Pacer): Promise<Control> {
  const hit = ctx.shared.get('surbl_control') as Control | undefined;
  if (hit) return hit;
  const groups = await serverGroups(ctx, s);
  const c: Control = { ok: false, servers: groups[0] ?? [], server: null, detail: groups.length === 0 ? 'no SURBL name server could be found' : '', evidenceId: null, next: 0 };
  const qname = `${s.control_name}.${s.zone}`;
  const why: string[] = [];
  for (const servers of groups) {
    const r = await ask(ctx, pace, s, servers, 0, qname);
    if (!r) { why.push('no SURBL server answered the control lookup'); continue; }
    const text = answerText(qname, r.server, r.ans);
    c.evidenceId = await storeEvidence(ctx.db, { source: 'surbl', url: `dns://${r.server}/${qname}/A`, retrievedAt: new Date(ctx.now()), httpStatus: null, contentType: 'text/plain', body: text, text, maxBytes: ctx.settings.evidence.max_text_bytes });
    const a = r.ans.answers.find((x) => x.type === 1 && /^127\./.test(x.data));
    if (r.ans.rcode === 0 && a && !s.blocked_answers.includes(a.data) && decodeBits(Number(a.data.split('.')[3]), s.list_bits).length > 0) {
      Object.assign(c, { ok: true, servers, server: r.server, detail: '' });
      break;
    }
    why.push(`the control name ${qname} was not answered as listed by ${r.server} (rcode ${r.ans.rcode}, ${r.ans.answers.map((x) => x.data).join(',') || 'no answer'})`);
  }
  if (!c.ok && why.length > 0) c.detail = why.join('; ');
  ctx.shared.set('surbl_control', c);
  return c;
}

export const surblCheck: Check = {
  id: 'surbl',
  gate: 'G4',
  ruleIds: ['SURBL-1'],
  lists: [],
  async run(ctx): Promise<CheckOutcome> {
    const s = ctx.settings.surbl;
    if (!ctx.settings.sources.surbl) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The SURBL source is switched off (sources.surbl)', { listed: null, control_ok: null });
    let pace = ctx.shared.get('surbl_pacer') as Pacer | undefined;
    if (!pace) { pace = new Pacer(MIN_MS_BETWEEN, 1, ctx.deps.sleep); ctx.shared.set('surbl_pacer', pace); }
    const c = await control(ctx, s, pace);
    const ev = (extra: number[] = []) => ({ evidenceIds: [...(c.evidenceId === null ? [] : [c.evidenceId]), ...extra], dataAsOf: new Date(ctx.now()) });
    if (!c.ok) return outcome('UNKNOWN', 'CONTROL_FAILED', `SURBL cannot be trusted this run: ${c.detail}`, { listed: null, lists: [], control_ok: false, server: c.server }, ev());

    const qname = `${ctx.item.domain}.${s.zone}`;
    const start = c.next++;
    const r = await ask(ctx, pace, s, c.servers, start, qname);
    if (!r) return outcome('UNKNOWN', 'TIMEOUT', 'No SURBL server answered', { listed: null, lists: [], control_ok: true, server: null }, ev());
    const text = answerText(qname, r.server, r.ans);
    const evId = await storeEvidence(ctx.db, { source: 'surbl', url: `dns://${r.server}/${qname}/A`, retrievedAt: new Date(ctx.now()), httpStatus: null, contentType: 'text/plain', body: text, text, maxBytes: ctx.settings.evidence.max_text_bytes });
    const base = { control_ok: true, server: r.server };
    const extra = { ...ev([evId]), upstreamCalls: 1 };
    const { rcode, answers } = r.ans;
    if (rcode === 3) return outcome('PASS', null, null, { ...base, listed: false, lists: [] }, extra);
    const a = answers.filter((x) => x.type === 1);
    if (rcode === 5 || a.some((x) => s.blocked_answers.includes(x.data))) {
      return outcome('UNKNOWN', 'QUERY_REFUSED', 'SURBL refused the query (answer 127.0.0.1 or REFUSED): this resolver is blocked, not "not listed"', { ...base, listed: null, lists: [], answers: a.map((x) => x.data) }, extra);
    }
    const hitA = a.find((x) => /^127\.\d+\.\d+\.\d+$/.test(x.data));
    if (rcode === 0 && hitA) {
      const lists = decodeBits(Number(hitA.data.split('.')[3]), s.list_bits);
      return outcome('FAIL', 'SURBL_LISTED', `${ctx.item.domain} is listed on SURBL${lists.length ? ` (${lists.join(', ')})` : ''}`, { ...base, listed: true, lists, answer: hitA.data }, extra);
    }
    return outcome('UNKNOWN', 'SOURCE_ERROR', `Unexpected SURBL answer (rcode ${rcode}, ${a.map((x) => x.data).join(',') || 'no A record'})`, { ...base, listed: null, lists: [] }, extra);
  },
};
