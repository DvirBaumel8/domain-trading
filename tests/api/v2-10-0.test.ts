// v2.10.0 (CR-011 part B): block list, company document, forbidden terms, review packets, feedback, items, status, cost, REVIEW_OVERDUE.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateToken } from '../../src/auth/tokens.js';
import { checkText } from '../../src/services/blocklist.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const T0 = Date.parse('2026-10-20T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
async function boot(env?: Record<string, string>) {
  const clock = { t: T0 };
  const app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock.t, env });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  const doc = async (text: string) => { const x = await post('/company/document', { text }); expect(x.statusCode, x.body).toBeLessThan(300); return x; };
  return { app, clock, post, get, doc, write: w, read: r };
}
const feedbackOk = (items: object[] = [], extra: object = {}) => ({ status: 'ok', provider: 'acme-ai', model: 'm-1', cost_usd: 0.25, items, ...extra });
const item = (text: string, category = 'pricing', severity = 'medium') => ({ category, severity, text });

describe('block list (T11-3)', () => {
  it('a configured secret value is refused as TEXT_BLOCKED category secret, and the text is never echoed or audited', async () => {
    const t = await boot();
    const text = 'our registrar login is fake_godaddy_pat_0000000000 ok';
    const r = await t.post('/company/document', { text });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('TEXT_BLOCKED');
    expect(r.json().error.details).toEqual({ category: 'secret' });
    expect(r.body).not.toContain('fake_godaddy_pat');
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/company/document').execute();
    expect(JSON.stringify(audit)).not.toContain('fake_godaddy_pat');
    expect(await db.selectFrom('company_documents').selectAll().execute()).toHaveLength(0);
  });

  it('a DOM bearer token, a key shape, an email, a phone number and a listed term each give their category', async () => {
    const t = await boot();
    await t.post('/company/forbidden-terms', { term: 'Project Falcon' });
    await t.post('/company/forbidden-terms', { term: 'zeta' });
    const cases: [string, string][] = [
      [`token ${generateToken()}`, 'secret'],
      ['key pk1_abcdef123456', 'secret'],
      ['key AIzaSyA1234567890abcdefghijk_lmn', 'secret'],
      ['key ghp_abcdefghij1234', 'secret'],
      ['key github_pat_11ABCDEFG', 'secret'],
      ['write to someone.name+tag@example.co.il please', 'email'],
      ['call +972 54-123-4567 today', 'phone'],
      ['call (03) 123 4567', 'phone'],
      ['call 0541234567', 'phone'],
      ['we are doing PROJECT falcon next', 'listed_term'],
      ['the Zeta name', 'listed_term'],
    ];
    for (const [text, category] of cases) {
      t.clock.t += 120_000; // stay under the write rate limit
      const r = await t.post('/company/document', { text });
      expect(r.statusCode, text).toBe(422);
      expect(r.json().error.code).toBe('TEXT_BLOCKED');
      expect(r.json().error.details, text).toEqual({ category });
      expect(r.body).not.toMatch(/falcon|zeta|example\.co|123 4567|0541234567|pk1_/i);
    }
  });

  it('no false positives on dates, money, hashes, ordinary prose, or a term inside a longer word', async () => {
    await db.insertInto('forbidden_terms').values({ term: 'zeta', created_by: 'test' }).execute();
    const ok = [
      'Bought on 2026-10-07 for $1,488 and listed 2026-10-07 12:30.',
      'Revenue was $1,488,000 in 2026, up 12-15 percent; order 12345678.',
      `sha ${'1234567890'.repeat(6)}ab and ${'a1b2c3d4'.repeat(8)}`,
      'The company buys short .com names, renews once, and sells at a fixed price. Contact: the chief of staff.',
      'We discussed xzetax and zetabyte storage only in the abstract.',
      'Floors at 65% of BIN; min offer $100; 50 names; 2 years.',
    ];
    for (const text of ok) expect(await checkText(db, text, { secretValues: [] }), text).toEqual({ ok: true });
  });

  it('a configured value shorter than 8 characters is not a secret', async () => {
    expect(await checkText(db, 'the word secret1 appears', { secretValues: ['secret1'] })).toEqual({ ok: true });
    expect(await checkText(db, 'the word secret12 appears', { secretValues: ['secret12'] })).toEqual({ ok: false, category: 'secret' });
  });
});

describe('company document (T11-14)', () => {
  it('stores versions only on change, lists them newest first, returns text and a unified diff against the previous version', async () => {
    const t = await boot();
    const a = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ version: 1, changed: true });
    expect(a.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    const same = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ version: 1, changed: false, sha256: a.json().sha256 });
    const b = await t.post('/company/document', { text: 'Line one\nLine 2\n' });
    expect(b.statusCode).toBe(201);
    expect(b.json().version).toBe(2);
    const list = await t.get('/company/document/versions');
    expect(list.json().versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list.json().versions[0]).toMatchObject({ bytes: 'Line one\nLine 2\n'.length, sha256: b.json().sha256 });
    const v2 = await t.get('/company/document/versions/2');
    expect(v2.statusCode).toBe(200);
    expect(v2.json().text).toBe('Line one\nLine 2\n');
    expect(v2.json().diff).toContain('-Line two\n+Line 2\n');
    const v1 = await t.get('/company/document/versions/1');
    expect(v1.json().diff).toBeNull();
    // going back to an earlier text is a new version (only the latest is compared)
    const back = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(back.statusCode).toBe(201);
    expect(back.json().version).toBe(3);
  });

  it('DOCUMENT_VERSION_NOT_FOUND for an unknown or malformed version; strict body and size are validated', async () => {
    const t = await boot();
    await t.doc('x doc');
    for (const n of ['2', '0', 'abc']) {
      const r = await t.get(`/company/document/versions/${n}`);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('DOCUMENT_VERSION_NOT_FOUND');
    }
    expect((await t.post('/company/document', { text: '' })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'a'.repeat(65537) })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'ok', extra: 1 })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'a'.repeat(65536) })).statusCode).toBe(201);
  });

  it('a READ token cannot upload (403), and a WRITE token is needed for terms', async () => {
    const t = await boot();
    const r = await t.app.inject({ method: 'POST', url: '/company/document', headers: { ...t.read, 'idempotency-key': randomUUID() }, payload: { text: 'hello' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('forbidden terms', () => {
  it('a term is stored append-only and no route ever returns it', async () => {
    const t = await boot();
    const r = await t.post('/company/forbidden-terms', { term: 'Secret Codename 77' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: 1, category: 'listed_term', created_at: expect.any(String) });
    expect(r.body).not.toMatch(/codename/i);
    const g = await t.get('/company/forbidden-terms');
    expect(g.json()).toEqual({ terms: [{ id: 1, category: 'listed_term', created_at: expect.any(String), retired_at: null }] });
    expect(g.body).not.toMatch(/codename/i);
    const audit = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    expect(audit).not.toMatch(/codename/i);
    expect((await t.post('/company/forbidden-terms', { term: 'x' })).statusCode).toBe(422);
    expect((await t.post('/company/forbidden-terms', { term: 'ab', category: 'email' })).statusCode).toBe(422);
  });
});

describe('review packet (T11-15..17, T11-24, T11-25)', () => {
  it('DOCUMENT_MISSING (409) without a document', async () => {
    const t = await boot();
    const r = await t.post('/reviews/packet');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('DOCUMENT_MISSING');
  });

  it('the first packet is weekly with the full text; later ones are daily with the diff since the last packet; weekly again after 7 days', async () => {
    const t = await boot();
    await t.doc('Company v1\n');
    const p1 = await t.post('/reviews/packet');
    expect(p1.statusCode, p1.body).toBe(201);
    const c1 = p1.json();
    expect(c1).toMatchObject({ kind: 'weekly', document_version: 1, packet_id: expect.stringMatching(/^rvp_[0-9a-f]{12}$/) });
    expect(c1.content.document).toMatchObject({ version: 1, text: 'Company v1\n', diff_since: null });
    expect(c1.content.dom_changes.since).toBeNull();
    expect(c1.content.dom_changes.service_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c1.content.dom_changes.settings_versions.some((s: { active: boolean }) => s.active)).toBe(true);
    expect(c1.content.numbers.budget).toBeDefined();

    // v2.15.0 (CR-013 F-1): a packet counts as the weekly one only after a review with status ok has received it
    expect((await t.post(`/reviews/${c1.packet_id}/feedback`, feedbackOk())).statusCode).toBe(201);
    t.clock.t = T0 + 2 * HOUR;
    await t.doc('Company v1\nNew paragraph\n');
    const p2 = (await t.post('/reviews/packet')).json();
    expect(p2.kind).toBe('daily');
    expect(p2.content.document.text).toBeNull();
    expect(p2.content.document.diff_since.from_version).toBe(1);
    expect(p2.content.document.diff_since.diff).toContain('+New paragraph');
    expect(p2.content.dom_changes.since).toMatch(/\+03:00$/);

    t.clock.t = T0 + 7 * DAY; // exactly 7 days after the weekly one: not yet due (strictly older than 7 days)
    expect((await t.post('/reviews/packet')).json().kind).toBe('daily');
    t.clock.t = T0 + 7 * DAY + 1000;
    const p4 = (await t.post('/reviews/packet')).json();
    expect(p4.kind).toBe('weekly');
    expect(p4.content.document.text).toBe('Company v1\nNew paragraph\n');

    const stored = await t.get(`/reviews/packets/${p4.packet_id}`);
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ packet_id: p4.packet_id, kind: 'weekly', sha256: p4.sha256, content: p4.content });
    expect(p4.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PACKET_NOT_FOUND', async () => {
    const t = await boot();
    const r = await t.get('/reviews/packets/rvp_000000000000');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('PACKET_NOT_FOUND');
  });

  it('carries listing changes, offers, sales and failed job steps since the last packet, and nowhere a walk-away', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    const id = await insertOwnedDomain(db, { domain: 'walk-test.com', status: 'listed', category: 'other', price_grade: null, listing_mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71424, min_offer_cents: 10000, pricing_source: 'formula', pricing_settings_version: 2 });
    await db.insertInto('listing_history').values({ domain_id: id, at: new Date(T0 - HOUR), source: 'list', category: 'other', mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71424 }).execute();
    await db.insertInto('offers').values({
      domain_id: id, amount_cents: 20000, source: 'afternic', received_at: new Date(T0 - HOUR), band: 'mid_range', routing: 'dvir', outcome: 'open', recorded_by: 'gavriel', walkaway_cents_at: 71424, created_at: new Date(T0 - HOUR),
    }).execute();
    await db.insertInto('job_runs').values({ job: 'daily', trigger: 'scheduled', started_at: new Date(T0 - 2 * HOUR), finished_at: new Date(T0 - HOUR), skipped: false, ok: false, steps: JSON.stringify({ reconciler: { ok: true, summary: {} }, backup: { ok: false, error: 'boom happened' } }) }).execute();
    const pv = await t.post('/reviews/packet', { preview: true });
    expect(pv.statusCode, pv.body).toBe(200);
    const c = pv.json().content;
    expect(c.dom_changes.listing_changes).toEqual([{ domain: 'walk-test.com', at: expect.any(String), source: 'list', mode: 'hybrid', bin_cents: 148800, floor_cents: 96700 }]);
    expect(c.dom_changes.offers).toEqual([{ domain: 'walk-test.com', amount_cents: 20000, outcome: 'open', at: expect.any(String) }]);
    expect(c.dom_changes.failed_job_steps).toEqual([{ job: 'daily', step: 'backup', at: expect.any(String), error: 'boom happened' }]);
    expect(pv.body).not.toMatch(/walk.?away/i);
    expect(pv.body).not.toContain('71424');
    const real = await t.post('/reviews/packet');
    expect(real.body).not.toMatch(/walk.?away/i);
    const stored = await db.selectFrom('review_packets').select('content').executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.content)).not.toMatch(/walk.?away/i);
  });

  it('the block list runs over the whole packet: 422 TEXT_BLOCKED with the category and nothing stored', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    await insertOwnedDomain(db, { domain: 'falconheavy.com' });
    await t.post('/company/forbidden-terms', { term: 'falconheavy' });
    const r = await t.post('/reviews/packet');
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('TEXT_BLOCKED');
    expect(r.json().error.details).toEqual({ category: 'listed_term' });
    expect(r.body).not.toContain('falconheavy');
    expect(await db.selectFrom('review_packets').selectAll().execute()).toHaveLength(0);
    const pv = await t.post('/reviews/packet?preview=true');
    expect(pv.statusCode).toBe(422);
  });

  it('preview returns the packet and stores nothing (query or body flag)', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    const a = await t.post('/reviews/packet?preview=true');
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ preview: true, kind: 'weekly' });
    expect(a.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    const b = await t.post('/reviews/packet', { preview: true });
    expect(b.statusCode).toBe(200);
    expect(await db.selectFrom('review_packets').selectAll().execute()).toHaveLength(0);
    // a preview does not start the weekly clock: the next real packet is still the first, weekly one
    expect((await t.post('/reviews/packet')).json().kind).toBe('weekly');
  });

  it('REVIEW_COST_CAP (409) once the month spend (the gemini provider only, F9) reaches the cap; GET /reviews/cost shows it', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    const p = (await t.post('/reviews/packet')).json();
    expect((await t.get('/reviews/cost')).json()).toEqual({ month: '2026-10', spent_usd: 0, cap_usd: 5, feedback_n: 0, unknown_n: 0, enabled: true, model: 'gemini-3.8-flash', tier: 'free' });
    t.clock.t = T0 + HOUR;
    const f = await t.post(`/reviews/${p.packet_id}/feedback`, feedbackOk([], { provider: 'gemini', cost_usd: 4.9999 }));
    expect(f.statusCode, f.body).toBe(201);
    expect((await t.post('/reviews/packet')).statusCode).toBe(201); // 4.9999 < 5
    const p2 = (await db.selectFrom('review_packets').select('id').orderBy('created_at', 'desc').orderBy('id').execute())[0]!.id;
    expect((await t.post(`/reviews/${p2}/feedback`, { status: 'unknown', provider: 'gemini', cost_usd: 0.0001, reason: 'timeout' })).statusCode).toBe(201);
    const r = await t.post('/reviews/packet');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('REVIEW_COST_CAP');
    expect(r.json().error.details).toEqual({ spent_usd: 5, cap_usd: 5 });
    expect((await t.post('/reviews/packet?preview=true')).statusCode).toBe(409);
    expect((await t.get('/reviews/cost')).json()).toEqual({ month: '2026-10', spent_usd: 5, cap_usd: 5, feedback_n: 1, unknown_n: 1, enabled: true, model: 'gemini-3.8-flash', tier: 'free' });
    t.clock.t = Date.parse('2026-11-02T09:00:00Z'); // a new calendar month
    expect((await t.get('/reviews/cost')).json()).toMatchObject({ month: '2026-11', spent_usd: 0 });
    expect((await t.post('/reviews/packet')).statusCode).toBe(201);
  });
});

describe('review feedback (T11-18, T11-19, T11-23)', () => {
  async function packet(t: Awaited<ReturnType<typeof boot>>) {
    await t.doc(`Doc ${randomUUID().slice(0, 4)}\n`);
    return (await t.post('/reviews/packet')).json().packet_id as string;
  }

  it('ok feedback with items: ids, novelty new, stored once; FEEDBACK_EXISTS on a second try; PACKET_NOT_FOUND for an unknown packet', async () => {
    const t = await boot();
    const id = await packet(t);
    const r = await t.post(`/reviews/${id}/feedback`, feedbackOk([item('The price list is too high for geo names'), item('Lander copy lacks urgency', 'copy', 'low')]));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().feedback_id).toBe(1);
    expect(r.json().items).toEqual([
      { id: 1, category: 'pricing', severity: 'medium', novelty: 'new', repeats_item_id: null },
      { id: 2, category: 'copy', severity: 'low', novelty: 'new', repeats_item_id: null },
    ]);
    const again = await t.post(`/reviews/${id}/feedback`, feedbackOk([]));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('FEEDBACK_EXISTS');
    const nf = await t.post('/reviews/rvp_ffffffffffff/feedback', feedbackOk([]));
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('PACKET_NOT_FOUND');
    const row = await db.selectFrom('review_feedback').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'ok', provider: 'acme-ai', model: 'm-1', cost_usd: '0.2500', reason: null });
  });

  it('unknown feedback keeps the provider status and reason (a reason is required, items are not allowed)', async () => {
    const t = await boot();
    const id = await packet(t);
    expect((await t.post(`/reviews/${id}/feedback`, { status: 'unknown', provider: 'acme-ai' })).statusCode).toBe(422);
    expect((await t.post(`/reviews/${id}/feedback`, { status: 'unknown', provider: 'acme-ai', reason: 'x', items: [] })).statusCode).toBe(422);
    const r = await t.post(`/reviews/${id}/feedback`, { status: 'unknown', provider: 'acme-ai', reason: 'provider answered 529' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().items).toEqual([]);
    const row = await db.selectFrom('review_feedback').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'unknown', model: null, cost_usd: '0.0000', reason: 'provider answered 529' });
  });

  it('item texts and the reason pass the block list (TEXT_BLOCKED), and nothing is stored', async () => {
    const t = await boot();
    const id = await packet(t);
    const a = await t.post(`/reviews/${id}/feedback`, feedbackOk([item('fine'), item('mail the owner at bob@example.com')]));
    expect(a.statusCode).toBe(422);
    expect(a.json().error.code).toBe('TEXT_BLOCKED');
    expect(a.json().error.details).toEqual({ category: 'email' });
    const b = await t.post(`/reviews/${id}/feedback`, { status: 'unknown', provider: 'p', reason: 'key pk1_abcdef123456 leaked' });
    expect(b.json().error.details).toEqual({ category: 'secret' });
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('review_items').selectAll().execute()).toHaveLength(0);
  });

  it('validates the body: lower-case category, severity, limits, strict keys', async () => {
    const t = await boot();
    const id = await packet(t);
    for (const body of [
      feedbackOk([item('x', 'Pricing')]), feedbackOk([item('x', 'pricing', 'urgent')]), feedbackOk([item('')]),
      feedbackOk([], { cost_usd: -1 }), feedbackOk([], { cost_usd: 101 }), feedbackOk([], { extra: 1 }), feedbackOk(Array.from({ length: 51 }, () => item('x'))),
    ]) expect((await t.post(`/reviews/${id}/feedback`, body)).statusCode).toBe(422);
  });

  it('novelty: Jaccard >= 0.6 on the words that matter within the same category is a repeat; a repeat of a repeat points to the original', async () => {
    const t = await boot();
    const id1 = await packet(t);
    const r1 = await t.post(`/reviews/${id1}/feedback`, feedbackOk([
      item('The landing page headline should mention price and urgency clearly'),
      item('The landing page headline should mention price and urgency clearly', 'other'), // same words, other category: new
    ]));
    expect(r1.json().items.map((i: { novelty: string }) => i.novelty)).toEqual(['new', 'new']);
    t.clock.t = T0 + 2 * HOUR;
    const id2 = (await t.post('/reviews/packet')).json().packet_id as string;
    const r2 = await t.post(`/reviews/${id2}/feedback`, feedbackOk([
      item('Landing page headline should mention price and urgency!'), // repeat of item 1
      item('Totally different remark about registrar renewals and expiry dates'), // new
    ]));
    expect(r2.json().items).toEqual([
      { id: 3, category: 'pricing', severity: 'medium', novelty: 'repeat', repeats_item_id: 1 },
      { id: 4, category: 'pricing', severity: 'medium', novelty: 'new', repeats_item_id: null },
    ]);
    t.clock.t = T0 + 4 * HOUR;
    const id3 = (await t.post('/reviews/packet')).json().packet_id as string;
    const r3 = await t.post(`/reviews/${id3}/feedback`, feedbackOk([
      item('headline should mention price urgency'), // closest to item 3 (a repeat) or 1: points to the original, 1
      item('Remark about registrar renewals expiry dates'), // repeat of item 4
      item('Unrelated: marketplace commission schedule'),
    ]));
    const its = r3.json().items;
    expect(its[0]).toMatchObject({ novelty: 'repeat', repeats_item_id: 1 });
    expect(its[1]).toMatchObject({ novelty: 'repeat', repeats_item_id: 4 });
    expect(its[2]).toMatchObject({ novelty: 'new', repeats_item_id: null });
  });

  it('items inside one feedback are compared with each other too', async () => {
    const t = await boot();
    const id = await packet(t);
    const r = await t.post(`/reviews/${id}/feedback`, feedbackOk([item('Registrar renewal price is unclear'), item('Registrar renewal price unclear')]));
    expect(r.json().items[1]).toMatchObject({ novelty: 'repeat', repeats_item_id: r.json().items[0].id });
  });
});

describe('review items and status (T11-20)', () => {
  it('items list newest first with the current status; status changes append rows (audited); view=new hides repeats of rejected items', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    const id1 = (await t.post('/reviews/packet')).json().packet_id as string;
    await t.post(`/reviews/${id1}/feedback`, feedbackOk([item('Headline should mention price and urgency clearly'), item('Registrar renewal price is unclear', 'costs', 'high')]));
    t.clock.t = T0 + 2 * HOUR;
    const id2 = (await t.post('/reviews/packet')).json().packet_id as string;
    await t.post(`/reviews/${id2}/feedback`, feedbackOk([item('Headline should mention price urgency clearly'), item('Registrar renewal price unclear', 'costs')]));
    // items: 1, 2 new; 3 repeats 1; 4 repeats 2

    const all = (await t.get('/reviews/items?view=all')).json().items;
    expect(all.map((i: { id: number }) => i.id)).toEqual([4, 3, 2, 1]);
    expect(all[3]).toMatchObject({ id: 1, packet_id: id1, kind: 'weekly', category: 'pricing', severity: 'medium', novelty: 'new', repeats_item_id: null, status: null });
    expect(all[0]).toMatchObject({ kind: 'daily', novelty: 'repeat', repeats_item_id: 2 });
    expect((await t.get('/reviews/items')).json().items).toHaveLength(4); // default view=new, nothing rejected yet

    const s = await t.post('/reviews/items/1/status', { status: 'rejected', note: 'Price is fixed by the founder rules' });
    expect(s.statusCode, s.body).toBe(201);
    expect(s.json()).toEqual({ item_id: 1, status: 'rejected', note: 'Price is fixed by the founder rules', at: expect.any(String) });
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/reviews/items/1/status').executeTakeFirstOrThrow();
    expect(audit.status_code).toBe(201);
    expect(audit.scope).toBe('write');
    expect(JSON.stringify(audit.request)).not.toContain('founder rules');
    const st = await db.selectFrom('review_item_statuses').selectAll().executeTakeFirstOrThrow();
    expect(st.audit_id).toBe(audit.id);

    expect((await t.get('/reviews/items')).json().items.map((i: { id: number }) => i.id)).toEqual([4, 2, 1]); // 3 repeats rejected item 1: hidden
    expect((await t.get('/reviews/items?view=all')).json().items).toHaveLength(4);
    // latest row is the current status
    await t.post('/reviews/items/1/status', { status: 'watching', note: 'Reopened' });
    expect((await t.get('/reviews/items')).json().items).toHaveLength(4);
    const one = (await t.get('/reviews/items?view=all&status=watching')).json().items;
    expect(one.map((i: { id: number }) => i.id)).toEqual([1]);
    expect(one[0].status).toEqual({ status: 'watching', note: 'Reopened', at: expect.any(String) });
    expect(await db.selectFrom('review_item_statuses').selectAll().execute()).toHaveLength(2);
    expect((await t.get('/reviews/items?view=all&limit=2')).json().items).toHaveLength(2);
    expect((await t.get('/reviews/items?view=weird')).statusCode).toBe(400);
    expect((await t.get('/reviews/items?limit=501')).statusCode).toBe(400);
  });

  it('REVIEW_ITEM_NOT_FOUND, validation and the block list on the note', async () => {
    const t = await boot();
    const nf = await t.post('/reviews/items/99/status', { status: 'acted', note: 'done' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('REVIEW_ITEM_NOT_FOUND');
    await t.doc('Doc\n');
    const id = (await t.post('/reviews/packet')).json().packet_id as string;
    await t.post(`/reviews/${id}/feedback`, feedbackOk([item('Something to act on')]));
    expect((await t.post('/reviews/items/1/status', { status: 'bogus', note: 'x' })).statusCode).toBe(422);
    expect((await t.post('/reviews/items/1/status', { status: 'acted', note: '' })).statusCode).toBe(422);
    const b = await t.post('/reviews/items/1/status', { status: 'acted', note: 'tell bob@example.com' });
    expect(b.statusCode).toBe(422);
    expect(b.json().error.code).toBe('TEXT_BLOCKED');
    expect(await db.selectFrom('review_item_statuses').selectAll().execute()).toHaveLength(0);
  });
});

describe('/report REVIEW_OVERDUE', () => {
  it('warns (warn level) when feedback exists and the newest is older than 36 hours; not before, not with no feedback', async () => {
    const t = await boot();
    const codes = async () => ((await t.get('/report')).json().warnings as { code: string; level: string; details: Record<string, unknown> }[]);
    expect((await codes()).some((w) => w.code === 'REVIEW_OVERDUE')).toBe(false);
    await t.doc('Doc\n');
    const id = (await t.post('/reviews/packet')).json().packet_id as string;
    await t.post(`/reviews/${id}/feedback`, feedbackOk([]));
    t.clock.t = T0 + 36 * HOUR;
    expect((await codes()).some((w) => w.code === 'REVIEW_OVERDUE')).toBe(false);
    t.clock.t = T0 + 36 * HOUR + 1000;
    const w = (await codes()).find((x) => x.code === 'REVIEW_OVERDUE');
    expect(w).toMatchObject({ level: 'warn', details: { last_feedback_at: expect.stringMatching(/\+03:00$/) } });
  });
});

describe('append-only (CR-011 part B tables)', () => {
  it('company_documents, forbidden_terms, review_packets, review_feedback, review_items and review_item_statuses refuse UPDATE and DELETE (append-only)', async () => {
    const t = await boot();
    await t.doc('Doc\n');
    await t.post('/company/forbidden-terms', { term: 'zzterm' });
    const id = (await t.post('/reviews/packet')).json().packet_id as string;
    await t.post(`/reviews/${id}/feedback`, feedbackOk([item('An item')]));
    await t.post('/reviews/items/1/status', { status: 'acted', note: 'done' });
    await expect(db.updateTable('company_documents').set({ text: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('company_documents').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('forbidden_terms').set({ term: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('forbidden_terms').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('review_packets').set({ kind: 'daily' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('review_packets').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('review_feedback').set({ provider: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('review_feedback').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('review_items').set({ severity: 'low' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('review_items').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('review_item_statuses').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('review_item_statuses').execute()).rejects.toThrow(/append-only/);
  });
});
