// What the Wayback Machine keeps about a name: page addresses that point to an adult, pharma, gambling or spam past. Addresses only, no page is read.
import { readText, SourceError, type Fetch } from '../sources/client.js';

export interface History {
  /** `no_hits` is not "clean": only addresses were looked at. */
  status: 'no_hits' | 'no_snapshots' | 'suspect' | 'killed' | 'error' | 'not_checked';
  pages: number | null;
  /** More pages exist than were read. */
  partial: boolean;
  first_snapshot: string | null;
  evidence: { date: string; url: string }[];
  reason: string | null;
}
export type HistoryFn = (domain: string) => Promise<History>;

const LIMIT = 300;
const BAD = new Set(['porn', 'porno', 'xxx', 'sex', 'nude', 'nudes', 'escort', 'escorts', 'hentai', 'camgirl', 'camgirls', 'viagra', 'cialis', 'levitra', 'kamagra', 'tramadol', 'xanax', 'casino', 'casinos', 'poker', 'gambling', 'baccarat', 'roulette', 'sportsbook', 'togel', 'judi', 'replica', 'replicas', 'payday']);
/** One address can be a stray link; two make a past. */
const KILL_AT = 2;
/** The archive asks for slow reading (about 24 a minute at most). */
const GAP_MS = 4000;
const BUDGET_MS = 40 * 60_000;
const MAX_FAILURES_IN_A_ROW = 5;

const blank = (status: History['status'], reason: string | null = null): History => ({ status, pages: null, partial: false, first_snapshot: null, evidence: [], reason });

export function readHistory(domain: string, text: string): History {
  const lines = text.split('\n').filter(Boolean).map((l) => /^(\d{14}) (\S+)$/.exec(l));
  if (lines.some((m) => m === null)) return blank('error', 'BAD_RESPONSE');
  if (lines.length === 0) return blank('no_snapshots');
  const pages = lines.map((m) => ({ date: `${m![1]!.slice(0, 4)}-${m![1]!.slice(4, 6)}-${m![1]!.slice(6, 8)}`, url: m![2]! }));
  const hits = pages.filter(({ url }) => {
    // the name itself never counts: only what comes before and after it
    const rest = url.toLowerCase().replace(/^https?:\/\//, '').replace(domain, ' ');
    let plain = rest;
    try { plain = decodeURIComponent(rest); } catch { /* keep it as written */ }
    return plain.split(/[^a-z]+/).some((w) => BAD.has(w));
  });
  return {
    status: hits.length >= KILL_AT ? 'killed' : hits.length > 0 ? 'suspect' : 'no_hits', pages: pages.length, partial: pages.length >= LIMIT,
    first_snapshot: pages.length >= LIMIT ? null : pages.map((p) => p.date).sort()[0]!, evidence: hits.slice(0, 5).map((h) => ({ date: h.date, url: h.url.slice(0, 200) })), reason: null,
  };
}

export function createHistory(now: () => number, sleep: (ms: number) => Promise<unknown>, fetchFn: Fetch = fetch): HistoryFn {
  let until: number | null = null;
  let next = 0;
  let failures = 0;
  return async (domain) => {
    until ??= now() + BUDGET_MS;
    if (failures >= MAX_FAILURES_IN_A_ROW) return blank('not_checked', 'the archive stopped answering');
    if (now() > until) return blank('not_checked', 'the time for this run is used');
    if (now() < next) await sleep(next - now());
    next = now() + GAP_MS;
    const url = `https://web.archive.org/cdx/search/cdx?url=${domain}&matchType=domain&fl=timestamp,original&filter=statuscode:200&filter=mimetype:text/html&collapse=urlkey&limit=${LIMIT}`;
    try {
      const answer = readHistory(domain, await readText(fetchFn, { source: 'wayback', url, timeoutMs: 45_000 }));
      failures = 0;
      return answer;
    } catch (e) {
      failures++;
      return blank('error', e instanceof SourceError ? e.code : 'BAD_RESPONSE');
    }
  };
}
