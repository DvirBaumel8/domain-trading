// G4 SURBL (CAP-05, SURBL-1): `<domain>.<zone>` A lookups sent straight to the zone's authoritative servers (public resolvers
// are refused, DR-001). A name is only ever asked of a server that has itself answered the control name (a name that must be
// listed) as listed in this run: an unproven server (one that answers NXDOMAIN to everything) can never produce a "not listed".
// No server provable -> every name UNKNOWN CONTROL_FAILED.
// v5.44.0: the same machinery serves URIBL (`uriblCheck`, pre-bid check URIBL-1): `dnsblCheck(spec)` is the one implementation, a spec names the zone settings, the state keys and how a listed answer is judged.
import { Pacer } from '../rdap-batch.js';
import { storeEvidence } from '../evidence.js';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check, type CheckContext, type CheckOutcome } from '../types.js';

type SurblSettings = SelectionValuesT['surbl'];
type Answer = { rcode: number; answers: { type: number; data: string }[] };

/** Per run: the servers, which of them passed the control, and the evidence of every control query. */
interface State { candidates: string[]; status: Map<string, 'proven' | 'failed' | 'pending'>; proven: string[]; controlQueries: number; charged: number; evidenceIds: number[]; next: number; init: Promise<void> | null }

const MIN_MS_BETWEEN = 200; // <= 5 queries/s in total (sources.md)
const QUERY_TIMEOUT_MS = 2000; // a name waits at most 3 proven servers x 2 s, so 50 names take about a minute even with a bad server
const TARGET_PROVEN = 3;
const MAX_CONTROL_QUERIES = 10;
const MAX_SERVERS_PER_NAME = 3;

/** What differs between two DNS blocklists that answer the same way (127.0.0.x, 127.0.0.1 = refused). */
interface DnsblSpec {
  ruleIds: string[]; name: string; key: string; evidenceSource: string;
  /** The zone settings of this list. */
  settings(ctx: CheckContext): SurblSettings;
  enabled(ctx: CheckContext): boolean;
  /** Judges a listed answer (the list names its bits decoded): FAIL, FLAG or (never) PASS. */
  listed(domain: string, lists: string[], answer: string): { status: 'FAIL' | 'FLAG'; code: string; reason: string };
}

const isIPv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** Decodes the last octet of a 127.0.0.x answer with the settings' list_bits. */
function decodeBits(lastOctet: number, listBits: Record<string, string>): string[] {
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
 * Candidate server IPs, in the order they are proven: the settings' `ns_override` (alone when set); else the zone's own NS records;
 * then SURBL's documented query hosts a..j of the zone's parent (sources.md: `multi.surbl.org` has no NS records of its own;
 * the NS of `surbl.org` answer the control with no data).
 */
async function candidatesOf(ctx: CheckContext, s: SurblSettings): Promise<string[]> {
  if (s.ns_override.length > 0) return hostsToIps(ctx, s.ns_override);
  const out: string[] = [];
  const add = (ips: string[]) => { for (const ip of ips) if (!out.includes(ip)) out.push(ip); };
  add(await hostsToIps(ctx, await ctx.deps.resolveNs(s.zone).catch(() => [] as string[])));
  const parent = s.zone.split('.').slice(1).join('.');
  if (parent.includes('.')) add(await hostsToIps(ctx, 'abcdefghij'.split('').map((l) => `${l}.${parent}`)));
  return out;
}

const answerText = (qname: string, server: string, a: Answer | null) =>
  a === null ? `;; ${qname} A @${server}\n;; no answer (timeout or unusable reply)` : `;; ${qname} A @${server}\n;; rcode ${a.rcode}\n${a.answers.map((x) => `${qname} A ${x.data}`).join('\n')}`.trim();

async function evidence(spec: DnsblSpec, ctx: CheckContext, qname: string, server: string, a: Answer | null): Promise<number> {
  if (ctx.shared.get('surbl_no_evidence') === true) return 0; // the portfolio check keeps no screening evidence rows (CR-007 G-5)
  const text = answerText(qname, server, a);
  return storeEvidence(ctx.db, { source: spec.evidenceSource, url: `dns://${server}/${qname}/A`, retrievedAt: new Date(ctx.now()), httpStatus: null, contentType: 'text/plain', body: text, text, maxBytes: ctx.settings.evidence.max_text_bytes });
}

/** Asks the control name of the next untried candidate. Returns false when none is left or the per-run cap is reached. */
async function proveNext(spec: DnsblSpec, ctx: CheckContext, st: State, s: SurblSettings, pace: Pacer): Promise<boolean> {
  const server = st.candidates.find((c) => !st.status.has(c));
  if (server === undefined || st.controlQueries >= MAX_CONTROL_QUERIES) return false;
  st.controlQueries++;
  st.status.set(server, 'pending'); // marked before the await: a concurrent caller must not prove the same server twice
  const qname = `${s.control_name}.${s.zone}`;
  let a: Answer | null;
  try {
    a = await pace.run(() => ctx.deps.dnsQuery(qname, 1, { server, timeoutMs: Math.min(s.timeout_ms, QUERY_TIMEOUT_MS) }));
  } catch {
    a = null; // a thrown query is an unproven server, not a stuck 'pending' one
  }
  st.evidenceIds.push(await evidence(spec, ctx, qname, server, a));
  const hit = a?.answers.find((x) => x.type === 1 && /^127\./.test(x.data));
  const ok = a !== null && a.rcode === 0 && hit !== undefined && !s.blocked_answers.includes(hit.data) && decodeBits(Number(hit.data.split('.')[3]), s.list_bits).length > 0;
  st.status.set(server, ok ? 'proven' : 'failed');
  if (ok) st.proven.push(server);
  return true;
}

async function stateOf(spec: DnsblSpec, ctx: CheckContext, s: SurblSettings, pace: Pacer): Promise<State> {
  let st = ctx.shared.get(`${spec.key}_state`) as State | undefined;
  if (!st) {
    st = { candidates: [], status: new Map(), proven: [], controlQueries: 0, charged: 0, evidenceIds: [], next: 0, init: null };
    ctx.shared.set(`${spec.key}_state`, st);
    const me = st;
    me.init = (async () => {
      me.candidates = await candidatesOf(ctx, s);
      while (me.proven.length < TARGET_PROVEN && (await proveNext(spec, ctx, me, s, pace))) { /* keep proving */ }
    })();
  }
  await st.init;
  return st;
}

function dnsblCheck(spec: DnsblSpec): Check {
  return {
  id: spec.key as Check['id'], // 'uribl' is run only by the pre-bid check, never registered as a screening check
  gate: 'G4',
  ruleIds: spec.ruleIds,
  lists: [],
  async run(ctx): Promise<CheckOutcome> {
    const s = spec.settings(ctx);
    const NAME = spec.name;
    if (!spec.enabled(ctx)) return outcome('UNKNOWN', 'SOURCE_DISABLED', `The ${NAME} source is switched off (sources.surbl)`, { listed: null, control_ok: null });
    let pace = ctx.shared.get(`${spec.key}_pacer`) as Pacer | undefined;
    if (!pace) { pace = new Pacer(MIN_MS_BETWEEN, 1, ctx.deps.sleep); ctx.shared.set(`${spec.key}_pacer`, pace); }
    const st = await stateOf(spec, ctx, s, pace);
    // Every control query is an upstream call: it is charged once, to the name whose run made it (or needed it).
    const chargeControl = () => { const n = st.controlQueries - st.charged; st.charged = st.controlQueries; return n; };
    const ev = (extra: number[] = []) => ({ evidenceIds: [...st.evidenceIds, ...extra], dataAsOf: new Date(ctx.now()) });
    if (st.proven.length === 0) {
      return outcome('UNKNOWN', 'CONTROL_FAILED', `${NAME} cannot be trusted this run: ${st.candidates.length === 0 ? 'no SURBL name server could be found' : `none of ${st.status.size} server(s) answered the control name ${s.control_name}.${s.zone} as listed`}`,
        { listed: null, lists: [], control_ok: false, server: null }, { ...ev(), upstreamCalls: chargeControl() });
    }

    const qname = `${ctx.item.domain}.${s.zone}`;
    const tried = new Set<string>();
    let got: { server: string; ans: Answer } | null = null;
    let sawServfail = false;
    const start = st.next++;
    while (got === null && tried.size < MAX_SERVERS_PER_NAME) {
      const open = st.proven.filter((p) => !tried.has(p));
      const server = open.length > 0 ? open[start % open.length]! : undefined;
      if (server === undefined) {
        if (!(await proveNext(spec, ctx, st, s, pace))) break; // every proven server failed for this name: prove one more, then ask it
        continue;
      }
      tried.add(server);
      const ans = await pace.run(() => ctx.deps.dnsQuery(qname, 1, { server, timeoutMs: Math.min(s.timeout_ms, QUERY_TIMEOUT_MS) }));
      if (ans === null) continue;
      if (ans.rcode === 2) { sawServfail = true; continue; }
      got = { server, ans };
    }
    if (!got) {
      return outcome('UNKNOWN', sawServfail ? 'SOURCE_ERROR' : 'TIMEOUT', sawServfail ? `The proven ${NAME} servers answered SERVFAIL` : `No proven ${NAME} server answered`, { listed: null, lists: [], control_ok: true, server: null }, { ...ev(), upstreamCalls: tried.size + chargeControl() });
    }
    const evId = await evidence(spec, ctx, qname, got.server, got.ans);
    const base = { control_ok: true, server: got.server };
    const extra = { ...ev([evId]), upstreamCalls: tried.size + chargeControl() };
    const { rcode, answers } = got.ans;
    if (rcode === 3) return outcome('PASS', null, null, { ...base, listed: false, lists: [] }, extra);
    const a = answers.filter((x) => x.type === 1);
    if (rcode === 5 || a.some((x) => s.blocked_answers.includes(x.data))) {
      return outcome('UNKNOWN', 'QUERY_REFUSED', `${NAME} refused the query (answer 127.0.0.1 or REFUSED): this resolver is blocked, not "not listed"`, { ...base, listed: null, lists: [], answers: a.map((x) => x.data) }, extra);
    }
    const hitA = a.find((x) => /^127\.\d+\.\d+\.\d+$/.test(x.data));
    if (rcode === 0 && hitA) {
      const lists = decodeBits(Number(hitA.data.split('.')[3]), s.list_bits);
      if (lists.length === 0) {
        return outcome('UNKNOWN', 'SOURCE_ERROR', `${NAME} answered ${hitA.data}, which sets no known list bit`, { ...base, listed: null, lists: [], answer: hitA.data }, extra);
      }
      const j = spec.listed(ctx.item.domain, lists, hitA.data);
      return outcome(j.status, j.code, j.reason, { ...base, listed: true, lists, answer: hitA.data }, extra);
    }
    return outcome('UNKNOWN', 'SOURCE_ERROR', `Unexpected ${NAME} answer (rcode ${rcode}, ${a.map((x) => x.data).join(',') || 'no A record'})`, { ...base, listed: null, lists: [] }, extra);
  },
  };
}

export const surblCheck: Check = dnsblCheck({
  ruleIds: ['SURBL-1'], name: 'SURBL', key: 'surbl', evidenceSource: 'surbl',
  settings: (ctx) => ctx.settings.surbl,
  enabled: (ctx) => ctx.settings.sources.surbl,
  listed: (domain, lists) => ({ status: 'FAIL', code: 'SURBL_LISTED', reason: `${domain} is listed on SURBL (${lists.join(', ')})` }),
});

/**
 * v5.44.0 (research funnel-names-safety §5 item 8): URIBL, queried like SURBL (authoritative servers, control name, a refusal is never "not listed").
 * The zone settings are fixed here (no selection-settings change); the on/off switch is `sources.surbl`. Answers: 127.0.0.2 black, .4 grey, .8 red (sums are
 * combinations, 127.0.0.14 = all three); 127.0.0.1 = query refused. Black is a FAIL; grey or red alone is a FLAG for a human. The control name `test.uribl.com` is
 * URIBL's documented always-listed test name (not re-verified live on 25 Oct 2026: an unprovable zone is a FLAG, never a pass).
 */
export const URIBL_ZONE = { zone: 'multi.uribl.com', control_name: 'test.uribl.com', blocked_answers: ['127.0.0.1'], list_bits: { '2': 'black', '4': 'grey', '8': 'red' }, ns_override: [] as string[] };
export const uriblCheck: Check = dnsblCheck({
  ruleIds: ['URIBL-1'], name: 'URIBL', key: 'uribl', evidenceSource: 'uribl',
  settings: (ctx) => ({ ...ctx.settings.surbl, ...URIBL_ZONE }),
  enabled: (ctx) => ctx.settings.sources.surbl,
  listed: (domain, lists) => lists.includes('black')
    ? { status: 'FAIL', code: 'URIBL_BLACK', reason: `${domain} is listed on URIBL black (${lists.join(', ')})` }
    : { status: 'FLAG', code: 'URIBL_GREY_RED', reason: `${domain} is on URIBL ${lists.join(' and ')}: read why before bidding` },
});
