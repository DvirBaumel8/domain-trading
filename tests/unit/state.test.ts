import { describe, expect, it } from 'vitest';
import { loadState, MAX_DOMAINS, parseState, problems, rewrites, type Domain, type LedgerEntry, type State } from '../../src/state.js';

const dom = (n: number, o: Partial<Domain> = {}): Domain => ({ domain: `name${n}.com`, display_name: `Name${n}.com`, deal_id: `D-${String(n).padStart(3, '0')}`, registrar: 'porkbun', expiry_date: '2027-10-04', status: 'owned', ...o });
const buy = (n: number, o: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: n, date: '2026-10-09', type: 'purchase', domain: `name${n}.com`, amount_cents: -1108, note: 'x', approval: { approved_on: '2026-10-09', ref: 'r' }, ...o });
const base = (): State => ({ domains: [dom(1), dom(2)], ledger: [buy(1), buy(2)] });
const withRow = (o: Partial<LedgerEntry>, s = base()): State => ({ ...s, ledger: [...s.ledger, { ...buy(s.ledger.length + 1, { domain: 'name1.com' }), ...o }] });
const ok = { approved_on: '2026-10-09', ref: 'r' };

describe('data/state.json itself', () => {
  it('passes every rule: 5 domains owned, $71.16 spent', () => {
    const s = loadState();
    expect(s.domains.map((d) => d.domain)).toEqual(['promptinjectionaudit.com', 'ukcbamcompliance.com', 'aievalsconsulting.com', 'roofingvoiceagent.com', 'mineunited.com']);
    expect(s.ledger.slice(0, 5).reduce((n, r) => n + r.amount_cents, 0)).toBe(-7116);
  });
});

describe('problems', () => {
  it('a good state has none', () => expect(problems(base())).toEqual([]));

  it('founder rule 1: a purchase, renewal or sale without approval; a stale or later approval', () => {
    expect(problems({ ...base(), ledger: [buy(1, { approval: null }), buy(2)] })).toEqual([expect.stringMatching(/row 1: a purchase needs Dvir's approval/)]);
    expect(problems(withRow({ type: 'renewal', approval: null }))).toEqual([expect.stringMatching(/approval/)]);
    for (const approved_on of ['2026-10-05', '2026-10-10']) expect(problems({ ...base(), ledger: [buy(1, { approval: { approved_on, ref: 'r' } }), buy(2)] })).toEqual([expect.stringMatching(/3 days before/)]);
    expect(problems({ ...base(), ledger: [buy(1, { approval: { approved_on: '2026-10-06', ref: 'r' } }), buy(2)] })).toEqual([]);
  });

  it('founder rule 2: 40 owned domains, sold and dropped ones do not count', () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => i + 1);
    const s: State = { domains: n(MAX_DOMAINS + 1).map((i) => dom(i)), ledger: n(MAX_DOMAINS + 1).map((i) => buy(i)) };
    expect(problems(s)).toEqual([expect.stringMatching(/41 domains are owned; the cap is 40/)]);
    s.domains[0]!.status = 'dropped';
    expect(problems(s)).toEqual([]);
  });

  it('the $250 cap for one name', () => {
    expect(problems({ ...base(), ledger: [buy(1, { amount_cents: -25_000 }), buy(2)] })).toEqual([]);
    expect(problems({ ...base(), ledger: [buy(1, { amount_cents: -25_001 }), buy(2)] })).toEqual([expect.stringMatching(/\$250 cap/)]);
  });

  it('founder rule 3: one renewal', () => {
    const once = withRow({ type: 'renewal', approval: ok });
    expect(problems(once)).toEqual([]);
    expect(problems(withRow({ type: 'renewal', approval: ok }, once))).toEqual([expect.stringMatching(/renewed more than once/)]);
  });

  it.each(['cloudflare', 'namejet', 'snapnames', 'dropcatch'])('founder rule 5: %s is never used', (registrar) => {
    expect(problems({ ...base(), domains: [dom(1, { registrar }), dom(2)] })).toEqual([expect.stringMatching(/never used/)]);
  });

  it('duplicates: a domain twice, a deal twice, bought twice, bought never', () => {
    expect(problems({ domains: [dom(1), dom(1)], ledger: [buy(1)] }).join()).toMatch(/listed twice.*deal D-001 is used twice/);
    expect(problems(withRow({}))).toEqual([expect.stringMatching(/exactly one purchase/)]);
    expect(problems({ ...base(), ledger: [buy(1)] })).toEqual([expect.stringMatching(/name2.com needs exactly one purchase/)]);
  });

  it('a sale and the sold status go together', () => {
    const sold = { ...base(), domains: [dom(1, { status: 'sold' }), dom(2)] };
    const sale = { type: 'sale', amount_cents: 148_800, approval: ok } as const;
    expect(problems(withRow(sale, sold))).toEqual([]);
    expect(problems(sold)).toEqual([expect.stringMatching(/sold domain has one sale row/)]);
    expect(problems(withRow(sale))).toEqual([expect.stringMatching(/sold domain has one sale row/)]);
  });

  it('signs, ids and unknown domains', () => {
    expect(problems({ ...base(), ledger: [buy(1, { amount_cents: 1108 }), buy(2)] })).toEqual([expect.stringMatching(/money out/)]);
    expect(problems({ ...base(), ledger: [buy(1), buy(2, { id: 3 })] })).toEqual([expect.stringMatching(/ids run/)]);
    expect(problems(withRow({ type: 'cost', domain: 'other.com' }))).toEqual([expect.stringMatching(/not a listed domain/)]);
    expect(problems(withRow({ type: 'cost', domain: null, amount_cents: -499, approval: null }))).toEqual([]);
    expect(problems(withRow({ type: 'adjustment', amount_cents: 100, approval: null }))).toEqual([]);
  });
});

describe('parseState (the file is public)', () => {
  it.each(['floor_cents', 'walkaway_cents', 'bin_cents'])('refuses the private field %s', (f) => {
    expect(() => parseState(JSON.stringify({ ...base(), domains: [{ ...dom(1), [f]: 1 }, dom(2)] }))).toThrow(/Unrecognized key/);
  });
  it('refuses an approval text, a float amount, an unreal date and an uppercase name', () => {
    const t = (s: unknown) => () => parseState(JSON.stringify(s));
    expect(t({ ...base(), ledger: [{ ...buy(1), approval: { ...ok, text: 'yes' } }, buy(2)] })).toThrow();
    expect(t({ ...base(), ledger: [buy(1, { amount_cents: -11.08 }), buy(2)] })).toThrow();
    expect(t({ ...base(), ledger: [buy(1, { date: '2026-02-30' }), buy(2)] })).toThrow();
    expect(t({ ...base(), domains: [dom(1, { domain: 'Name1.com' }), dom(2)] })).toThrow();
  });
});

describe('rewrites (rows are only added)', () => {
  it('adding rows, a new domain, a status, registrar or expiry change is fine', () => {
    const after = withRow({ type: 'cost', approval: null });
    after.domains = [dom(1, { status: 'dropped', registrar: 'godaddy', expiry_date: '2028-10-04' }), dom(2), dom(3)];
    expect(rewrites(base(), after)).toEqual([]);
  });
  it('changing, removing or reordering a ledger row is refused', () => {
    const b = base();
    expect(rewrites(b, { ...b, ledger: [buy(1, { amount_cents: -1 }), buy(2)] })).toEqual([expect.stringMatching(/row 1 was changed/)]);
    expect(rewrites(b, { ...b, ledger: [buy(1)] })).toEqual([expect.stringMatching(/row 2 was changed or removed/)]);
    expect(rewrites(b, { ...b, ledger: [buy(2), buy(1)] })).toHaveLength(2);
  });
  it('removing a domain or changing its deal is refused', () => {
    const b = base();
    expect(rewrites(b, { ...b, domains: [dom(1)] })).toEqual([expect.stringMatching(/name2.com was removed/)]);
    expect(rewrites(b, { ...b, domains: [dom(1, { deal_id: 'D-009' }), dom(2)] })).toEqual([expect.stringMatching(/deal id/)]);
  });
});
