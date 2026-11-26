import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feedObjects, readFeed, type Feed, type Listing } from '../src/prefilter/feed.js';
import { createHistory, readHistory, type History } from '../src/prefilter/history.js';
import { nameCut, splits, bundledLists, type NameLists } from '../src/prefilter/names.js';
import { createExactNameSearch, parseResults, sameNameHits, type ExactNameResult, type ExactNameSearchFn } from '../src/prefilter/search.js';
import { gate, metrics, runPrefilter, type CloseRow, type RunInput, type ShadowRow } from '../src/prefilter/run.js';
import type { WebRisk } from '../src/sources/web-risk.js';
import { parseState, type State } from '../src/state.js';

const NOW = Date.parse('2026-11-25T15:25:00Z');
const BUILT = '2026-11-25T14:00:00Z';
const TOMORROW = '2026-11-26T18:00:00Z';
const approval = { approved_on: '2026-10-04', ref: 'r' };
const state = (extra: { domains?: unknown[]; ledger?: unknown[] } = {}): State => parseState(JSON.stringify({
  domains: [
    { domain: 'oldname.com', display_name: 'OldName.com', deal_id: 'D-001', registrar: 'porkbun', expiry_date: '2027-10-04', status: 'owned', do_not_renew_since: '2026-11-23' },
    { domain: 'mine.com', display_name: 'Mine.com', deal_id: 'D-005', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned', renewal_cents: 2200 },
    ...(extra.domains ?? []),
  ],
  ledger: [
    { id: 1, date: '2026-10-04', type: 'purchase', domain: 'oldname.com', amount_cents: -1108, note: 'n', approval },
    { id: 2, date: '2026-10-05', type: 'purchase', domain: 'mine.com', amount_cents: -2419, note: 'n', approval },
    ...(extra.ledger ?? []),
  ],
}));

const raw = (o: Record<string, unknown> = {}) => ({ domainName: 'GOODNAME.COM', link: 'https://x/goodname-com-738327432?isc=y', auctionType: 'Bid', auctionEndTime: TOMORROW, price: '$12', numberOfBids: 2, domainAge: 9, isAdult: false, exactMatchTlds: 4, developedTlds: 3, ...o });
const file = (rows: unknown[], meta: unknown = { lastBuildDate: BUILT, fieldDescription: { domainName: 'a "name" {[' } }) => JSON.stringify({ meta, data: rows }, null, 1);
async function* pieces(text: string, size = 7) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const read = (rows: unknown[], meta?: unknown) => readFeed(pieces(file(rows, meta)), NOW);

describe('the inventory file', () => {
  it('reads every row across pieces, with braces and quotes inside text', async () => {
    const rows = [raw(), raw({ domainName: 'OTHER.COM', description: 'odd "}]{[ \\ text' })];
    for (const size of [1, 2, 13, 100_000]) {
      const seen: unknown[] = [];
      for await (const o of feedObjects(pieces(file(rows), size))) if (o.kind === 'row') seen.push(JSON.parse(o.text));
      expect(seen).toEqual(rows);
    }
    expect((await read(rows)).listings[0]).toEqual({ domain: 'goodname.com', auctionId: '738327432', type: 'Bid', endsAt: Date.parse(TOMORROW), priceCents: 1200, bids: 2, age: 9, adult: false, exactMatchTlds: 4, developedTlds: 3 });
  });
  it('drops other endings, digits, hyphens and names over 13 letters, and counts each', async () => {
    const f = await read([raw(), raw({ domainName: 'A.NET' }), raw({ domainName: 'ABC1.COM' }), raw({ domainName: 'A-B.COM' }), raw({ domainName: 'ABCDEFGHIJKLM.COM' }), raw({ domainName: 'ABCDEFGHIJKLMN.COM' })]);
    expect(f.listings.map((l) => l.domain)).toEqual(['goodname.com', 'abcdefghijklm.com']);
    expect(f.counts).toEqual({ read: 6, not_com: 1, not_letters: 2, too_long: 1, unreadable: 0 });
  });
  it('a price of $1,234 and $5.50 is read exactly; an age that is missing is null', async () => {
    const f = await read([raw({ price: '$1,234' }), raw({ price: '$5.50', domainAge: undefined })]);
    expect(f.listings.map((l) => [l.priceCents, l.age])).toEqual([[123_400, 9], [550, null]]);
  });
  it('cut short, stale, undated, empty or changed is an error, never an empty list', async () => {
    const whole = file([raw(), raw()]);
    for (const cut of [whole.length - 1, whole.length - 3, 400]) await expect(readFeed(pieces(whole.slice(0, cut)), NOW)).rejects.toThrow(/ends early/);
    await expect(readFeed(pieces(''), NOW)).rejects.toThrow(/ends early/);
    await expect(readFeed(pieces('{"data":[}]}'), NOW)).rejects.toThrow(/not valid JSON/);
    await expect(read([raw()], { lastBuildDate: '2026-11-25T03:00:00Z' })).rejects.toThrow(/12 hours/);
    await expect(read([raw()], { title: 'x' })).rejects.toThrow(/no build date/);
    await expect(read([])).rejects.toThrow(/no usable rows/);
    await expect(read([raw(), raw({ price: 'call us' })])).rejects.toThrow(/over 1%/);
    await expect(read([{ name: 'x' }])).rejects.toThrow(/over 1%/);
  });
});

const listing = (o: Partial<Listing> = {}): Listing => ({ domain: 'goodname.com', auctionId: '1', type: 'Bid', endsAt: Date.parse(TOMORROW), priceCents: 1200, bids: 2, age: 9, adult: false, exactMatchTlds: 4, developedTlds: 3, ...o });
const closeout = (o: Partial<Listing> = {}): Listing => listing({ type: 'BuyNow', bids: 0, priceCents: 1100, endsAt: Date.parse('2026-11-25T18:00:00Z'), ...o });
const feed = (listings: Listing[]): Feed => ({ builtAt: Date.parse(BUILT), listings, counts: { read: listings.length, not_com: 0, not_letters: 0, too_long: 0, unreadable: 0 } });
const row = (o: Partial<ShadowRow> = {}): ShadowRow => ({ domain: 'goodname.com', source: 'auction', logged_at: '2026-11-24T17:25:00+02:00', ends_at: '2026-11-25T20:00:00+02:00', ...o } as ShadowRow);
const no = { state: state(), kills: new Set<string>(), logged: [] as ShadowRow[] };
const dropped = (source: 'auction' | 'closeout', l: Listing, i: Partial<typeof no> = {}) => Object.keys(gate(source, feed([l]), { ...no, ...i }, NOW).dropped)[0] ?? 'left';

describe('the gates', () => {
  it('an auction: 16 hours left, one bid, not adult, not owned, not killed before, not just logged', () => {
    expect(dropped('auction', listing())).toBe('left');
    expect(dropped('auction', listing({ endsAt: NOW + 16 * 3_600_000 }))).toBe('left');
    expect(dropped('auction', listing({ endsAt: NOW + 16 * 3_600_000 - 1 }))).toBe('under_16h');
    expect(dropped('auction', listing({ bids: 0 }))).toBe('no_bid');
    expect(dropped('auction', listing({ adult: true }))).toBe('adult');
    expect(dropped('auction', listing({ type: 'BuyNow' }))).toBe('wrong_type');
    expect(dropped('auction', listing({ domain: 'mine.com' }))).toBe('owned');
    expect(dropped('auction', listing(), { kills: new Set(['goodname.com']) })).toBe('prior_kill');
    expect(dropped('auction', listing(), { logged: [row()] })).toBe('already_logged');
    expect(dropped('auction', listing(), { logged: [row({ logged_at: '2026-11-10T17:25:00+02:00' })] })).toBe('left');
  });
  it('a closeout: $5 to $11, live on 3 endings, 5 years old, not ended', () => {
    for (const ok of [{}, { priceCents: 500 }, { age: 5 }]) expect(dropped('closeout', closeout(ok))).toBe('left');
    for (const priceCents of [499, 1101]) expect(dropped('closeout', closeout({ priceCents }))).toBe('price');
    for (const o of [{ developedTlds: 2 }, { age: 4 }, { age: null }]) expect(dropped('closeout', closeout(o))).toBe('no_demand_sign');
    expect(dropped('closeout', closeout({ endsAt: NOW }))).toBe('ended');
    expect(dropped('closeout', closeout({ type: 'Bid' }))).toBe('wrong_type');
  });
  it('the caps: $250 a name, $1,500 in total with the year-2 money, 40 names, $300 of closeouts', () => {
    expect(dropped('auction', listing({ priceCents: 25_000 }))).toBe('left');
    expect(dropped('auction', listing({ priceCents: 25_001 }))).toBe('over_per_name');
    const spent = (cents: number) => state({ ledger: [{ id: 3, date: '2026-11-01', type: 'cost', domain: null, amount_cents: -cents, note: 'n', approval: null }] });
    const room = 150_000 - 1108 - 2419 - 2200; // the year-2 renewal of mine.com; none is kept for oldname.com
    expect(dropped('auction', listing({ priceCents: 1200 }), { state: spent(room - 1200) })).toBe('left');
    expect(dropped('auction', listing({ priceCents: 1200 }), { state: spent(room - 1199) })).toBe('over_total');
    const n = Array.from({ length: 38 }, (_, k) => k + 10);
    const full = state({ domains: n.map((k) => ({ domain: `n${k}.com`, display_name: `N${k}.com`, deal_id: `D-0${k}`, registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned', renewal_cents: 1 })), ledger: n.map((k, i) => ({ id: i + 3, date: '2026-10-05', type: 'purchase', domain: `n${k}.com`, amount_cents: -100, note: 'n', approval })) });
    expect(dropped('auction', listing(), { state: full })).toBe('over_slots');
    const pilot = (cents: number) => state({ domains: [{ domain: 'co.com', display_name: 'Co.com', deal_id: 'D-006', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned', renewal_cents: 1 }], ledger: [{ id: 3, date: '2026-11-24', type: 'purchase', domain: 'co.com', amount_cents: -25_000, note: 'n', source: 'closeout', approval: { approved_on: '2026-11-24', ref: 'r' } }, { id: 4, date: '2026-11-24', type: 'cost', domain: 'co.com', amount_cents: -cents, note: 'n', approval: null }] });
    expect(dropped('closeout', closeout(), { state: pilot(3900) })).toBe('left');
    expect(dropped('closeout', closeout(), { state: pilot(3901) })).toBe('over_closeout_pilot');
    expect(dropped('auction', listing(), { state: pilot(3901) })).toBe('left');
  });
});

const nothing: History = { status: 'no_hits', pages: 3, partial: false, first_snapshot: '2015-01-01', evidence: [], reason: null };
const risk = (status: WebRisk['status']): WebRisk => ({ status, threatTypes: status === 'flagged' ? ['MALWARE'] : [], checkedAt: new Date(NOW), errorCode: status === 'error' ? 'TIMEOUT' : status === 'missing_key' ? 'KEY_MISSING' : null });
const run = (o: Partial<RunInput> = {}) => runPrefilter({ ...no, now: () => NOW, auctions: feed([listing()]), endingToday: feed([]), closeouts: feed([closeout({ domain: 'closeout.com' })]), closed: new Set(), webRisk: async () => risk('clean'), history: async () => nothing, exactName: async () => ({ status: 'no_hit' }), ...o });

describe('a run', () => {
  it('logs every name left, from both files, and never says the budget is within', async () => {
    const r = await run();
    expect(r.rows.map((x) => [x.domain, x.source, x.price_cents, x.budget])).toEqual([['goodname.com', 'auction', 1200, 'unknown'], ['closeout.com', 'closeout', 1100, 'unknown']]);
    expect(r.rows[0]).toMatchObject({ auction_id: '1', bids: 2, ends_at: '2026-11-26T20:00:00+02:00', checks: { trademark: { status: 'not_checked' }, spamhaus: { status: 'not_checked' } }, open_checks: ['budget', 'trademark', 'spamhaus'] });
  });
  it('a missing key, an error or an unread history stays open; a flagged name is killed', async () => {
    for (const s of ['missing_key', 'error'] as const) {
      const [x] = (await run({ webRisk: async () => risk(s) })).rows;
      expect(x!.checks.web_risk.status).toBe(s);
      expect(x!.open_checks).toContain('web_risk');
    }
    for (const h of [{ status: 'error' }, { status: 'not_checked' }, { status: 'suspect' }, { partial: true }] as Partial<History>[]) expect((await run({ history: async () => ({ ...nothing, ...h }) })).rows[0]!.open_checks, JSON.stringify(h)).toContain('history');
    const flagged = await run({ webRisk: async () => risk('flagged') });
    expect([flagged.rows.length, flagged.killed.map((k) => k.by)]).toEqual([0, ['web_risk', 'web_risk']]);
    const past = await run({ history: async () => ({ ...nothing, status: 'killed' }) });
    expect([past.rows.length, past.killed.map((k) => k.by)]).toEqual([0, ['history', 'history']]);
  });
  it('outside checks run only on names that passed the cheap gates', async () => {
    const asked: string[] = [];
    await run({ auctions: feed([listing({ bids: 0 }), listing({ domain: 'fine.com' })]), closeouts: feed([]), webRisk: async (d) => { asked.push(d); return risk('clean'); } });
    expect(asked).toEqual(['fine.com']);
  });
  it('a row has only known fields: no maximum, planned price, key or Buyer word can be in the public log', async () => {
    const [x] = (await run()).rows;
    expect(Object.keys(x!).sort()).toEqual(['age', 'auction_id', 'bids', 'budget', 'checks', 'developed_tlds', 'domain', 'ends_at', 'exact_match_tlds', 'file_built_at', 'logged_at', 'open_checks', 'price_cents', 'source']);
  });
  it('the day after: the last price and bids the file showed, marked not final; once a row, and null when it is gone', async () => {
    const logged = [row(), row({ domain: 'gone.com' }), row({ domain: 'co.com', source: 'closeout', ends_at: '2026-11-24T20:00:00+02:00' }), row({ domain: 'done.com' }), row({ domain: 'later.com', ends_at: '2026-11-26T20:00:00+02:00' })];
    const r = await run({ logged, closed: new Set(['done.com 2026-11-24T17:25:00+02:00']), endingToday: feed([listing({ priceCents: 4500, bids: 9 }), listing({ domain: 'done.com' })]), closeouts: feed([closeout({ domain: 'co.com', priceCents: 500 })]) });
    expect(r.closes).toEqual([
      { domain: 'goodname.com', source: 'auction', logged_at: '2026-11-24T17:25:00+02:00', last_price_cents: 4500, last_bids: 9, seen_at: '2026-11-25T16:00:00+02:00', final: false, reason: null },
      { domain: 'gone.com', source: 'auction', logged_at: '2026-11-24T17:25:00+02:00', last_price_cents: null, last_bids: null, seen_at: null, final: false, reason: 'not in the file' },
      { domain: 'co.com', source: 'closeout', logged_at: '2026-11-24T17:25:00+02:00', last_price_cents: 500, last_bids: 0, seen_at: '2026-11-25T16:00:00+02:00', final: false, reason: null },
    ]);
  });
  it('the numbers leave out the four names bought before this method', () => {
    const c = (domain: string, last_price_cents: number | null) => ({ domain, last_price_cents } as CloseRow);
    expect(metrics([row(), row({ domain: 'oldname.com' }), row({ domain: 'c.com', source: 'closeout' })], [c('goodname.com', 1), c('oldname.com', 1), c('c.com', null)], state())).toEqual({ auctions: 1, closeouts: 1, with_last_price: 1 });
  });
});

describe('the name in the past (Wayback)', () => {
  const text = (...urls: string[]) => urls.map((u, i) => `2015${String(i + 1).padStart(2, '0')}01000000 ${u}`).join('\n');
  it('two telling addresses kill, one is suspect, the name itself and parts of words never count', () => {
    expect(readHistory('a.com', text('http://a.com/online-casino', 'http://viagra.a.com/'))).toMatchObject({ status: 'killed', evidence: [{ date: '2015-01-01', url: 'http://a.com/online-casino' }, { date: '2015-02-01' }] });
    expect(readHistory('a.com', text('http://a.com/buy%20cialis', 'http://a.com/about'))).toMatchObject({ status: 'suspect', pages: 2, first_snapshot: '2015-01-01' });
    expect(readHistory('pokertable.com', text('http://www.pokertable.com/essex/poker-free'))).toMatchObject({ status: 'suspect' });
    expect(readHistory('casino.com', text('http://casino.com/', 'http://www.casino.com/sussex', 'http://casino.com/middlesex'))).toMatchObject({ status: 'no_hits' });
  });
  it('no pages is its own answer, 300 is partial, and an answer of another shape is an error', () => {
    expect(readHistory('a.com', '').status).toBe('no_snapshots');
    expect(readHistory('a.com', Array.from({ length: 300 }, (_, i) => `20150101000000 http://a.com/${i}`).join('\n'))).toMatchObject({ partial: true, first_snapshot: null });
    expect(readHistory('a.com', '<html>503</html>').status).toBe('error');
  });
  it('reads slowly, stops after 5 failures or 40 minutes, and never turns a failure into an answer', async () => {
    let t = NOW;
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); t += ms; };
    const ok = createHistory(() => t, sleep, async () => new Response('20150101000000 http://a.com/'));
    expect([(await ok('a.com')).status, (await ok('b.com')).status, waits]).toEqual(['no_hits', 'no_hits', [4000]]);
    t += 41 * 60_000;
    expect(await ok('c.com')).toMatchObject({ status: 'not_checked', reason: 'the time for this run is used' });
    let calls = 0;
    const down = createHistory(() => t, sleep, async () => { calls++; return new Response('busy', { status: 429 }); });
    const got = [];
    for (let i = 0; i < 7; i++) got.push((await down('a.com')).status);
    expect([got, calls]).toEqual([['error', 'error', 'error', 'error', 'error', 'not_checked', 'not_checked'], 5]);
  });
});

describe('where it writes', () => {
  const workflow = readFileSync('.github/workflows/prefilter.yml', 'utf8');
  it('the only push is to the branch shadow-log', () => {
    expect(workflow.match(/push .*$/gm)!.filter((l) => /refs|HEAD|main/.test(l))).toEqual(['push -q "https://github.com/$GITHUB_REPOSITORY.git" HEAD:refs/heads/shadow-log']);
    expect(workflow).toMatch(/persist-credentials: false/);
  });
  it('the script uses no git, writes only in the log folder, and reads the ledger before anything else', () => {
    const script = readFileSync('scripts/prefilter.ts', 'utf8');
    expect(script.match(/writeFileSync\([^;]*;/g)).toEqual(['writeFileSync(join(out, dir, name), text);']);
    expect(script).not.toMatch(/['"]git['"]|state\.json/);
    expect(script.indexOf('loadState();')).toBeLessThan(script.indexOf('await feed('));
  });
  it('the kill list is one .com name a line', () => {
    const lines = readFileSync('docs/requests/kills.txt', 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines.filter((l) => /^[a-z0-9-]+\.com$/.test(l)).length).toBeGreaterThan(0); // bots edit it; the job counts the lines it cannot read
  });
});

const set = (s: string) => new Set(s.split(' ').filter(Boolean));
const fixture: NameLists = { words: set('roof concept good name tomato close out fine'), given: set('joe tom amy'), places: set('houston'), trades: set('marina roofing') };

describe('the plain-word, person and local-business cuts', () => {
  const cut = (n: string, l: NameLists = fixture) => nameCut(n, l);
  it('one word and two words of the list stay; a split into three counts', () => {
    expect([cut('roofconcept'), cut('roof'), cut('roofconceptname')]).toEqual([null, null, null]);
    expect(splits('roofroofroofroof', fixture.words, 3)).toBe(false);
  });
  it('a coined name is not_plain_word', () => { expect([cut('xwsy'), cut('qynaps')]).toEqual(['not_plain_word', 'not_plain_word']); });
  it('a given name and a family name or trade is person_name', () => {
    expect([cut('joelevy'), cut('joemarina'), cut('roofingjoe')]).toEqual(['person_name', 'person_name', 'person_name']);
  });
  it('a place and a trade is local_business', () => { expect([cut('houstonmarina'), cut('marinahouston')]).toEqual(['local_business', 'local_business']); });
  it('letters that look like a name, but no clear shape, stay', () => {
    expect([cut('tomato'), cut('joey'), cut('houston')]).toEqual([null, 'not_plain_word', 'not_plain_word']); // a whole word is never a person; a short rest is no family name
  });
  it('the bundled lists: plain words pass, coined, person and local names are cut', () => {
    const l = bundledLists();
    expect(['roofconcept', 'civilcloud', 'timingdiagram', 'goodname', 'closeout', 'fine'].map((n) => nameCut(n, l))).toEqual([null, null, null, null, null, null]);
    expect(['xwsy', 'qynaps'].map((n) => nameCut(n, l))).toEqual(['not_plain_word', 'not_plain_word']);
    expect(['danielmooney', 'amytiemann'].map((n) => nameCut(n, l))).toEqual(['person_name', 'person_name']);
    expect(['houstonmarina', 'sflroofing'].map((n) => nameCut(n, l))).toEqual(['local_business', 'local_business']);
  });
  it('in the gate: each cut is counted by its reason, after the older gates', () => {
    const g = (domain: string) => Object.keys(gate('auction', feed([listing({ domain })]), { ...no, lists: fixture }, NOW).dropped)[0] ?? 'left';
    expect([g('roofconcept.com'), g('xwsy.com'), g('joelevy.com'), g('houstonmarina.com')]).toEqual(['left', 'not_plain_word', 'person_name', 'local_business']);
    expect(dropped('auction', listing({ domain: 'xwsy.com', bids: 0 }))).toBe('no_bid');
  });
});

describe('the quality cuts and the exact-name search in a run', () => {
  const spy = () => { const c = { risk: 0, history: 0, search: 0, asked: [] as string[] }; return { c, webRisk: async () => { c.risk++; return risk('clean'); }, history: async () => { c.history++; return nothing; }, exactName: async (d: string) => { c.search++; c.asked.push(d); return { status: 'no_hit' } as ExactNameResult; } }; };
  const names = (...d: string[]) => feed(d.map((domain) => listing({ domain })));
  it('a name cut by quality makes no Web Risk, history or search call', async () => {
    const s = spy();
    const r = await run({ auctions: names('xwsy.com', 'danielmooney.com', 'houstonmarina.com'), closeouts: feed([]), webRisk: s.webRisk, history: s.history, exactName: s.exactName });
    expect([s.c.risk, s.c.history, s.c.search, r.rows.length]).toEqual([0, 0, 0, 0]);
    expect(r.summary.auction!.dropped).toEqual({ not_plain_word: 1, person_name: 1, local_business: 1 });
  });
  it('the older reasons still drop the same rows', async () => {
    const r = await run({ auctions: feed([listing({ bids: 0 }), listing({ adult: true, domain: 'fine.com' })]), closeouts: feed([closeout({ priceCents: 100 })]) });
    expect([r.summary.auction!.dropped, r.summary.closeout!.dropped]).toEqual([{ no_bid: 1, adult: 1 }, { price: 1 }]);
  });
  it('a same-name hit is killed with the evidence and not logged', async () => {
    const r = await run({ closeouts: feed([]), exactName: async () => ({ status: 'hit', hits: [{ title: 'Goodname', url: 'https://goodname.io/' }] }) });
    expect([r.rows.length, r.killed]).toEqual([0, [{ domain: 'goodname.com', source: 'auction', by: 'exact_name_search', evidence: [{ title: 'Goodname', url: 'https://goodname.io/' }] }]]);
  });
  it('no hit is logged as checked; an error, a throw or no adapter is logged and left open, never clean', async () => {
    const [ok] = (await run({ closeouts: feed([]) })).rows;
    expect([ok!.checks.exact_name, ok!.open_checks]).toEqual([{ status: 'no_hit', reason: null }, ['budget', 'trademark', 'spamhaus']]);
    const bad: ExactNameSearchFn[] = [async () => ({ status: 'error', reason: 'TIMEOUT' }), async () => { throw new Error('boom'); }];
    for (const exactName of bad) {
      const [x] = (await run({ closeouts: feed([]), exactName })).rows;
      expect(x!.checks.exact_name.status).toBe('error');
      expect(x!.open_checks).toContain('exact_name');
    }
    const none = (await run({ closeouts: feed([]), exactName: undefined })).rows[0]!;
    expect([none.checks.exact_name.status, none.open_checks]).toEqual(['not_checked', ['budget', 'trademark', 'spamhaus', 'exact_name']]);
  });
  it('there is no cap: 20 names that pass are 20 searches', async () => {
    const s = spy();
    const twenty = Array.from({ length: 20 }, (_, k) => `good${'abcdefghijklmnopqrst'[k]}`).map((x) => `${x}word.com`);
    const lists: NameLists = { ...fixture, words: new Set([...fixture.words, ...twenty.map((t) => t.slice(0, -4))]) };
    await run({ auctions: names(...twenty), closeouts: feed([]), lists, ...s });
    expect(s.c.search).toBe(20);
  });
  it('the row still has only known fields', async () => {
    const [x] = (await run()).rows;
    expect(Object.keys(x!.checks).sort()).toEqual(['exact_name', 'history', 'spamhaus', 'trademark', 'web_risk']);
  });
});

describe('the DuckDuckGo adapter (never the network)', () => {
  const page = (...items: [string, string, string][]) => `<html><body>${items.map(([t, u, s]) => `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&amp;rut=x">${t}</a><a class="result__snippet" href="x">${s}</a></div>`).join('')}</body></html>`;
  const none = '<html><body><div class="no-results">No results.</div></body></html>';
  it('reads title, address and snippet only', () => {
    expect(parseResults(page(['Roof <b>Concept</b> | Roofing', 'https://roofconcept.io/a', 'We roof &amp; more']))).toEqual([{ title: 'Roof Concept | Roofing', url: 'https://roofconcept.io/a', snippet: 'We roof & more' }]);
    expect(parseResults(none)).toEqual([]);
    expect(parseResults('<html>Unusual traffic anomaly</html>')).toBeNull();
  });
  it('a site or a title that is the name is a hit; the name\'s own .com and explainers are not', () => {
    const r = (title: string, url: string) => ({ title, url, snippet: '' });
    expect(sameNameHits('roofconcept', [r('x', 'https://www.roofconcept.io/'), r('RoofConcept - Roofing', 'https://a.com/'), r('Roof concept', 'https://roofconcept.com/'), r('Roofconcept', 'https://en.wikipedia.org/wiki/Roofconcept'), r('A roof concept for homes', 'https://b.com/')]).map((h) => h.url)).toEqual(['https://www.roofconcept.io/', 'https://a.com/']);
  });
  it('answers: hit, no hit, and an unreadable page, a 429 or a throw are errors; it waits between requests and stops after 5 failures', async () => {
    let t = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); t += ms; };
    const hit = createExactNameSearch(() => t, sleep, async () => new Response(page(['Roofconcept', 'https://roofconcept.net/', ''])));
    expect((await hit('roofconcept.com')).status).toBe('hit');
    expect(waits.length).toBe(1);
    const clean = createExactNameSearch(() => t, sleep, async () => new Response(none));
    expect(await clean('roofconcept.com')).toEqual({ status: 'no_hit' });
    for (const f of [async () => new Response('<html>blocked</html>'), async () => new Response('busy', { status: 429 }), async () => { throw new Error('offline'); }]) {
      expect((await createExactNameSearch(() => t, sleep, f)('roofconcept.com')).status).toBe('error');
    }
    let calls = 0;
    const down = createExactNameSearch(() => t, sleep, async () => { calls++; return new Response('busy', { status: 429 }); });
    const got = [];
    for (let k = 0; k < 7; k++) got.push((await down('a.com')).status);
    expect([got, calls]).toEqual([Array(7).fill('error'), 10]);
  });
});
