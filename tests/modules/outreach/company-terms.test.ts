// v2.15.0 (CR-013 F-2, F-4, F-8), kept in 5.53.0 when the outside review was removed: the term retire route, key shapes, term matching.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { checkText, termMatches } from '../../../src/modules/outreach/blocklist.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-20T00:05:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

async function boot() {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { app, clock, post, get };
}
const rnd = (n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');

describe('F-2 retiring a term (T13-6)', () => {
  it('V215-6 T13-6: retire is audited, append-only, and makes the same text pass; 404 TERM_NOT_FOUND, 409 TERM_ALREADY_RETIRED; reads show retired_at, never the term', async () => {
    const t = await boot();
    const id = (await t.post('/company/forbidden-terms', { term: 'Blueberry' })).json().id as number;
    expect(await checkText(db, 'I like blueberry pie')).toEqual({ ok: false, category: 'listed_term' });
    expect((await t.post('/company/forbidden-terms/999/retire', {})).json().error.code).toBe('TERM_NOT_FOUND');
    expect((await t.post('/company/forbidden-terms/abc/retire', {})).json().error.code).toBe('TERM_NOT_FOUND');
    expect((await t.post(`/company/forbidden-terms/${id}/retire`, { reason: 'x'.repeat(201) })).statusCode).toBe(422);
    const r = await t.post(`/company/forbidden-terms/${id}/retire`, { reason: 'breaks the packet' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id, retired_by: expect.any(String), reason: 'breaks the packet' });
    expect(r.body).not.toMatch(/blueberry/i);
    const again = await t.post(`/company/forbidden-terms/${id}/retire`, {});
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'TERM_ALREADY_RETIRED']);
    expect(await checkText(db, 'I like blueberry pie')).toEqual({ ok: true });
    const g = await t.get('/company/forbidden-terms');
    expect(g.json().terms).toEqual([{ id, category: 'listed_term', created_at: expect.any(String), retired_at: expect.any(String) }]);
    expect(g.body).not.toMatch(/blueberry/i);
    const row = await db.selectFrom('forbidden_term_retirements').selectAll().executeTakeFirstOrThrow();
    const audit = await db.selectFrom('audit_log').selectAll().where('id', '=', row.audit_id!).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ method: 'POST', path: `/company/forbidden-terms/${id}/retire`, scope: 'write' });
    await expect(db.updateTable('forbidden_term_retirements').set({ reason: 'x' }).execute()).rejects.toThrow();
  });
});

describe('F-4 key shapes (T13-9)', () => {
  const shapes: [string, () => string][] = [
    ['sk-', () => `sk-${rnd(48)}`], ['sk-proj-', () => `sk-proj-${rnd(40, 'abcdefghijklmnopqrstuvwxyz0123456789_-')}`], ['sk-ant-', () => `sk-ant-api03-${rnd(40)}`],
    ['xoxb-', () => `xoxb-${rnd(12, '0123456789')}-${rnd(12, '0123456789')}-${rnd(24)}`], ['xoxp-', () => `xoxp-${rnd(12, '0123456789')}-${rnd(24)}`],
    ['xapp-', () => `xapp-1-${rnd(12)}-${rnd(20)}`], ['AKIA', () => `AKIA${rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`], ['rnd_', () => `rnd_${rnd(24)}`],
    ['JWT', () => `eyJ${rnd(20)}.eyJ${rnd(30)}.${rnd(30)}`],
  ];
  it('V215-9 T13-9: each shape is refused as secret on the company document; ordinary words pass', async () => {
    const t = await boot();
    for (const [name, make] of shapes) {
      const key = make();
      t.clock.t += 61_000; // the write limiter allows 10 per minute
      expect(await checkText(db, `use ${key} now`), name).toEqual({ ok: false, category: 'secret' });
      const doc = await t.post('/company/document', { text: `notes ${key}` });
      expect([name, doc.statusCode, doc.json().error.details.category]).toEqual([name, 422, 'secret']);
    }
    for (const ok of ['sk- alone and skill and skills', 'The task-force-management-committee met', 'risk-assessment-framework-for-everyone', 'rnd_short and AKIAshort', 'eyJ.a.b', 'ask-me-anything-about-domains-today']) {
      expect(await checkText(db, ok), ok).toEqual({ ok: true });
    }
  });
});

describe('F-8 term matching (T13-13)', () => {
  it('V215-10 a trailing s, es, \'s or ’s also matches; inside a longer word it does not', () => {
    for (const text of ['Shomers', "Shomer's", 'Shomer’s', 'Shomeres', 'the shomer.', '#Shomer', 'Shomer-bot']) expect(termMatches(text, 'Shomer'), text).toBe(true);
    for (const text of ['xshomerx', 'shomerish', 'shomersx', 'ashomer']) expect(termMatches(text, 'Shomer'), text).toBe(false);
  });
});
