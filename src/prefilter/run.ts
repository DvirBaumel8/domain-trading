// The daily pre-filter (CR-117): the cheap gates over two GoDaddy files, then the outside checks on what is left, then the rows of the shadow log.
// It judges nothing and buys nothing. Our own maximum and planned price never enter here: the log is public.
import { budget } from '../budget.js';
import { toJerusalemIso } from '../core/dates.js';
import type { WebRiskFn } from '../sources/web-risk.js';
import type { State } from '../state.js';
import type { Feed, Listing } from './feed.js';
import type { History, HistoryFn } from './history.js';

const MIN_HOURS_LEFT = 16;
/** Closeouts have no bids, so they need another sign of demand: the same name live on 3 other endings, and 5 years of age. */
export const CLOSEOUT = { minCents: 500, maxCents: 1100, minDevelopedTlds: 3, minAge: 5 };
/** A closeout is in the file on several days: it is logged once. */
const LOGGED_AGAIN_AFTER_MS = 14 * 86_400_000;
/** Never part of the new method's results (Dvir, 23 Nov 2026). */
const OLD_METHOD_DEALS: readonly string[] = ['D-001', 'D-002', 'D-003', 'D-004'];

export interface ShadowRow {
  domain: string; source: 'auction' | 'closeout'; auction_id: string | null; logged_at: string; file_built_at: string; ends_at: string;
  price_cents: number; bids: number; age: number | null; exact_match_tlds: number; developed_tlds: number;
  budget: 'unknown';
  checks: {
    web_risk: { status: 'clean' | 'missing_key' | 'error'; reason: string | null };
    history: History;
    trademark: { status: 'not_checked'; reason: string };
    spamhaus: { status: 'not_checked'; reason: string };
  };
  /** What a bot still has to check. Never empty: trademark and Spamhaus are never done here. */
  open_checks: string[];
}
export interface CloseRow { domain: string; source: ShadowRow['source']; logged_at: string; last_price_cents: number | null; last_bids: number | null; seen_at: string | null; final: false; reason: string | null }

export interface RunInput {
  state: State; now: () => number; kills: ReadonlySet<string>;
  auctions: Feed; endingToday: Feed; closeouts: Feed;
  /** Every row already in the log, and the ones that already have a close row (`domain logged_at`). */
  logged: readonly ShadowRow[]; closed: ReadonlySet<string>;
  webRisk: WebRiskFn; history: HistoryFn;
}

type Drops = Record<string, number>;
const closeKey = (r: { domain: string; logged_at: string }) => `${r.domain} ${r.logged_at}`;

export function gate(source: ShadowRow['source'], feed: Feed, i: Pick<RunInput, 'state' | 'kills' | 'logged'>, now: number): { left: Listing[]; dropped: Drops } {
  const dropped: Drops = {};
  const owned = new Set(i.state.domains.map((d) => d.domain));
  const recent = new Set(i.logged.filter((r) => now - Date.parse(r.logged_at) < LOGGED_AGAIN_AFTER_MS).map((r) => r.domain));
  const why = (l: Listing): string | null => {
    if (l.type !== (source === 'auction' ? 'Bid' : 'BuyNow')) return 'wrong_type';
    if (source === 'auction' ? l.endsAt - now < MIN_HOURS_LEFT * 3_600_000 : l.endsAt <= now) return source === 'auction' ? 'under_16h' : 'ended';
    if (l.adult) return 'adult';
    if (source === 'auction' && l.bids < 1) return 'no_bid';
    if (source === 'closeout') {
      if (l.priceCents < CLOSEOUT.minCents || l.priceCents > CLOSEOUT.maxCents) return 'price';
      if (l.developedTlds < CLOSEOUT.minDevelopedTlds || l.age === null || l.age < CLOSEOUT.minAge) return 'no_demand_sign';
    }
    if (owned.has(l.domain)) return 'owned';
    if (i.kills.has(l.domain)) return 'prior_kill';
    if (recent.has(l.domain)) return 'already_logged';
    // the renewal price is not in the file, so this can only say "over" or "unknown"
    const b = budget(i.state, { allInCents: l.priceCents, renewalCents: null, source }, null);
    return b.status === 'over' ? `over_${b.over[0]}` : null;
  };
  const left = feed.listings.filter((l) => {
    const reason = why(l);
    if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
    return reason === null;
  });
  return { left: left.sort((a, b) => b.bids - a.bids || b.developedTlds - a.developedTlds || a.domain.localeCompare(b.domain)), dropped };
}

/** The last price the files showed. Never the final one: no public file has it. */
function closes(i: RunInput): CloseRow[] {
  const now = i.now();
  const day = (t: number) => Math.floor(t / 86_400_000);
  return i.logged.filter((r) => !i.closed.has(closeKey(r)) && day(Date.parse(r.ends_at)) <= day(now)).map((r) => {
    const feed = r.source === 'auction' ? i.endingToday : i.closeouts;
    const l = feed.listings.find((x) => x.domain === r.domain);
    return {
      domain: r.domain, source: r.source, logged_at: r.logged_at, last_price_cents: l?.priceCents ?? null, last_bids: l?.bids ?? null,
      seen_at: l ? toJerusalemIso(new Date(feed.builtAt)) : null, final: false, reason: l ? null : 'not in the file',
    };
  });
}

/** The new method's numbers, without the four names bought before it. */
export function metrics(rows: readonly ShadowRow[], closed: readonly CloseRow[], state: State) {
  const old = new Set(state.domains.filter((d) => OLD_METHOD_DEALS.includes(d.deal_id)).map((d) => d.domain));
  const mine = rows.filter((r) => !old.has(r.domain));
  const seen = closed.filter((c) => !old.has(c.domain) && c.last_price_cents !== null);
  return { auctions: mine.filter((r) => r.source === 'auction').length, closeouts: mine.filter((r) => r.source === 'closeout').length, with_last_price: seen.length };
}

export async function runPrefilter(i: RunInput) {
  const now = i.now();
  const loggedAt = toJerusalemIso(new Date(now));
  const rows: ShadowRow[] = [];
  const killed: { domain: string; source: ShadowRow['source']; by: 'web_risk' | 'history'; evidence: unknown }[] = [];
  const seen: { domain: string; history: History }[] = [];
  const summary: Record<string, { file_built_at: string; counts: Feed['counts']; dropped: Drops; checked: number; logged: number }> = {};
  for (const [source, feed] of [['auction', i.auctions], ['closeout', i.closeouts]] as const) {
    const { left, dropped } = gate(source, feed, i, now);
    const before = rows.length;
    // the archive is slow and the time is short: the auctions that end soonest are read first, then the closeouts (the file order of `left` is kept for ties)
    if (source === 'auction') left.sort((a, b) => a.endsAt - b.endsAt);
    for (const l of left) {
      const risk = await i.webRisk(l.domain);
      if (risk.status === 'flagged') { killed.push({ domain: l.domain, source, by: 'web_risk', evidence: risk.threatTypes }); continue; }
      const history = await i.history(l.domain);
      seen.push({ domain: l.domain, history });
      if (history.status === 'killed') { killed.push({ domain: l.domain, source, by: 'history', evidence: history.evidence }); continue; }
      rows.push({
        domain: l.domain, source, auction_id: l.auctionId, logged_at: loggedAt, file_built_at: toJerusalemIso(new Date(feed.builtAt)), ends_at: toJerusalemIso(new Date(l.endsAt)),
        price_cents: l.priceCents, bids: l.bids, age: l.age, exact_match_tlds: l.exactMatchTlds, developed_tlds: l.developedTlds, budget: 'unknown',
        checks: {
          web_risk: { status: risk.status, reason: risk.errorCode }, history,
          trademark: { status: 'not_checked', reason: 'USPTO has no word search by API' },
          spamhaus: { status: 'not_checked', reason: 'free for non-commercial use only' },
        },
        open_checks: ['budget', 'trademark', 'spamhaus', ...(risk.status === 'clean' ? [] : ['web_risk']), ...(['no_hits', 'no_snapshots'].includes(history.status) && !history.partial ? [] : ['history'])],
      });
    }
    summary[source] = { file_built_at: toJerusalemIso(new Date(feed.builtAt)), counts: feed.counts, dropped, checked: left.length, logged: rows.length - before };
  }
  // names that errored get one more try at the end, if the 40 minutes are not used (a `not_checked` answer keeps the first error)
  for (const s of seen) {
    if (s.history.status !== 'error') continue;
    const again = await i.history(s.domain);
    if (again.status === 'not_checked') break;
    s.history = again;
    const row = rows.find((r) => r.domain === s.domain);
    if (again.status === 'killed') {
      rows.splice(rows.indexOf(row!), 1);
      killed.push({ domain: s.domain, source: row!.source, by: 'history', evidence: again.evidence });
      summary[row!.source]!.logged--;
    } else if (row) {
      row.checks.history = again;
      row.open_checks = row.open_checks.filter((c) => c !== 'history').concat(['no_hits', 'no_snapshots'].includes(again.status) && !again.partial ? [] : ['history']);
    }
  }
  const history_coverage = { checked: 0, reused: 0, not_checked: 0, error: 0 };
  for (const { history } of seen) history_coverage[history.reused_from ? 'reused' : history.status === 'not_checked' ? 'not_checked' : history.status === 'error' ? 'error' : 'checked']++;
  return { rows, history_coverage, closes: closes(i), killed, summary };
}
