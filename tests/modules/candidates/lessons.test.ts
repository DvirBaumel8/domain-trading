// v5.3.0: CR-053 scout lessons store (POST/GET/PATCH /lessons, /lessons/check, /lessons/report).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => Date.parse('2026-10-14T09:00:00Z') });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const post = (h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: '/lessons', headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const get = (h: Record<string, string>, url: string) => app.inject({ method: 'GET', url, headers: h });
const L = (o: Record<string, unknown> = {}) => ({ sector: 'S6', rule: 'r11', domain: 'cbamcheck.com', lesson: 'EU acronym plus compliance is taken', ...o });

describe('lessons', () => {
  it('LS-1: 3 lessons with one duplicate give 2 rows and a merged result; the merge adds a dated note and takes the newer recheck_if', async () => {
    const { w } = await setup();
    const res = await post(w, [L({ recheck_if: 'never' }), L({ domain: 'other.com', rule: 'taken', lesson: 'x' }), L({ domain: 'cbamcheck.com, new.com', lesson: 'second look: still taken', recheck_if: 'if CBAM changes' })]);
    expect(res.statusCode, res.body).toBe(201);
    const [a, b, c] = res.json().results;
    expect(a.merged).toBe(false); expect(b.merged).toBe(false);
    expect(c).toEqual({ id: a.id, merged: true });
    const rows = await db.selectFrom('scout_lessons').selectAll().execute();
    expect(rows).toHaveLength(2);
    const row = rows.find((x) => x.id === a.id)!;
    expect(row.domains.sort()).toEqual(['cbamcheck.com', 'new.com']);
    expect(row.recheck_if).toBe('if CBAM changes');
    expect(row.notes).toMatchObject([{ lesson: 'second look: still taken' }]);
  });

  it('LS-2: a lesson with no domain never merges; a superseded one is not merged into; the same text adds no note', async () => {
    const { w } = await setup();
    const [a, b] = (await post(w, [L({ domain: undefined }), L({ domain: undefined })])).json().results;
    expect(a.merged || b.merged).toBe(false);
    const c = (await post(w, L())).json().results[0];
    const d = (await post(w, L())).json().results[0];
    expect(d).toEqual({ id: c.id, merged: true });
    expect((await db.selectFrom('scout_lessons').select('notes').where('id', '=', c.id).executeTakeFirstOrThrow()).notes).toEqual([]);
    expect((await app.inject({ method: 'PATCH', url: `/lessons/${c.id}`, headers: { ...w, 'idempotency-key': randomUUID() }, payload: { superseded_by: a.id } })).statusCode).toBe(200);
    expect((await post(w, L())).json().results[0].merged).toBe(false);
  });

  it('LS-3: notes keep at most 20 entries', async () => {
    const { w } = await setup();
    await post(w, Array.from({ length: 26 }, (_, i) => L({ lesson: `look ${i}` })));
    const row = await db.selectFrom('scout_lessons').selectAll().executeTakeFirstOrThrow();
    expect((row.notes as unknown[]).length).toBe(20);
  });

  it('LS-4: GET filters by sector, rule, since and q; limit; check finds a merged name', async () => {
    const { w, r } = await setup();
    await post(w, [L(), L({ sector: 'S4', rule: 'taken', domain: 'vendorpair.com', lesson: 'vendors never use the pair' }), L({ domain: 'new.com', lesson: 'merged one' })]);
    await post(w, L({ domain: 'cbamcheck.com', lesson: 'again, merged note' }));
    expect((await get(r, '/lessons?sector=S6')).json().count).toBe(2);
    expect((await get(r, '/lessons?rule=TAKEN')).json().lessons[0].sector).toBe('S4');
    expect((await get(r, '/lessons?q=VENDORS')).json().count).toBe(1);
    expect((await get(r, '/lessons?q=again')).json().count).toBe(1); // found in notes
    expect((await get(r, '/lessons?q=vendorpair')).json().count).toBe(1); // found in domains
    expect((await get(r, '/lessons?since=2026-10-15')).json().count).toBe(0);
    expect((await get(r, '/lessons?since=2026-10-14')).json().count).toBe(3);
    expect((await get(r, '/lessons?limit=1')).json().count).toBe(1);
    expect((await get(r, '/lessons?limit=1001')).statusCode).toBe(400);
    expect((await get(r, '/lessons?sector=S9')).statusCode).toBe(400);
    const chk = await get(r, '/lessons/check?domain=New.com');
    expect(chk.json()).toMatchObject({ domain: 'new.com', count: 1 });
    expect((await get(r, '/lessons/check?domain=nothing.com')).json().count).toBe(0);
    expect((await get(r, '/lessons/check?domain=bad name')).statusCode).toBe(422);
  });

  it('LS-5: validation: missing sector, rule or lesson, bad enums, long text, bad domain', async () => {
    const { w } = await setup();
    for (const bad of [L({ sector: undefined }), L({ rule: undefined }), L({ lesson: undefined }), L({ sector: 'S5' }), L({ scout: 'x' }), L({ rule: 'x'.repeat(21) }),
      L({ lesson: 'x'.repeat(301) }), L({ extra: 1 })]) {
      const res = await post(w, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await post(w, L({ domain: 'not a domain' }))).json().error.code).toBe('DOMAIN_INVALID');
    expect(await db.selectFrom('scout_lessons').select('id').execute()).toHaveLength(0);
  });

  it('LS-6: rule is lowercased; auth: no token 401, READ token 403 on writes, key required, replay returns the same answer', async () => {
    const { w, r } = await setup();
    expect((await app.inject({ method: 'GET', url: '/lessons' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/lessons', payload: L() })).statusCode).toBe(401);
    expect((await post(r, L())).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/lessons', headers: w, payload: L() })).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const k = randomUUID();
    const one = await post(w, L({ rule: 'R11' }), k);
    const two = await post(w, L({ rule: 'R11' }), k);
    expect(two.headers['idempotent-replayed']).toBe('true');
    expect(two.json().results).toEqual(one.json().results);
    expect(await db.selectFrom('scout_lessons').select('rule').execute()).toEqual([{ rule: 'r11' }]);
    expect(await db.selectFrom('audit_log').select('id').where('id', '=', one.json().audit_id).execute()).toHaveLength(1);
  });

  it('LS-7: PATCH edits recheck_if, superseded_by and lesson only; 404; superseded_by must exist; idempotency key required; audited', async () => {
    const { w, r } = await setup();
    const [a, b] = (await post(w, [L({ domain: 'a.com' }), L({ domain: 'b.com' })])).json().results;
    const patch = (id: string, payload: unknown, h: Record<string, string> = { ...w, 'idempotency-key': randomUUID() }) =>
      app.inject({ method: 'PATCH', url: `/lessons/${id}`, headers: h, payload: payload as object });
    const ok = await patch(a.id, { recheck_if: 'if rule changes', lesson: 'new text', superseded_by: b.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().lesson).toMatchObject({ recheck_if: 'if rule changes', lesson: 'new text', superseded_by: b.id });
    expect((await patch(a.id, { superseded_by: null })).json().lesson.superseded_by).toBeNull();
    expect((await patch('les_missing', { lesson: 'x' })).json().error.code).toBe('LESSON_NOT_FOUND');
    expect((await patch(a.id, { superseded_by: 'les_nope' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await patch(a.id, { superseded_by: a.id })).statusCode).toBe(422);
    expect((await patch(a.id, { rule: 'r1' })).statusCode).toBe(422);
    expect((await patch(a.id, {})).statusCode).toBe(422);
    expect((await patch(a.id, { lesson: 'x'.repeat(301) })).statusCode).toBe(422);
    expect((await patch(a.id, { lesson: 'x' }, w)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await patch(a.id, { lesson: 'x' }, { ...r, 'idempotency-key': randomUUID() })).statusCode).toBe(403);
    expect((await db.selectFrom('audit_log').select('id').where('method', '=', 'PATCH').execute()).length).toBeGreaterThan(0);
  });

  it('LS-8: report: top rule per sector, 2 examples, recurring flag at 3, month window, markdown', async () => {
    const { w, r } = await setup();
    await post(w, [
      L({ domain: 'a1.com' }), L({ domain: 'a2.com', lesson: 'two' }), L({ domain: 'a3.com', lesson: 'three' }),
      L({ domain: 'a4.com', rule: 'taken', lesson: 'four' }), L({ sector: 'S4', rule: 'typo', domain: 'a5.com', lesson: 'five' }),
    ]);
    await db.insertInto('scout_lessons').values({
      id: 'les_old', created_at: new Date('2026-09-30T10:00:00Z'), updated_at: new Date('2026-09-30T10:00:00Z'), scout: 'rules', sector: 'S6', domains: [], rule: 'old',
      lesson: 'september', notes: '[]', recheck_if: 'never', source_file: null, superseded_by: null, created_by: 'x',
    }).execute();
    const rep = (await get(r, '/lessons/report?month=2026-10')).json();
    expect(rep.lessons_n).toBe(5);
    const s6 = rep.sectors.find((s: { sector: string }) => s.sector === 'S6');
    expect(s6.top_rules[0]).toMatchObject({ rule: 'r11', count: 3, recurring: true, flag: 'recurring – is the rule or the method wrong?' });
    expect(s6.top_rules[0].examples).toHaveLength(2);
    expect(s6.top_rules[1]).toMatchObject({ rule: 'taken', count: 1, recurring: false });
    expect(rep.recurring).toEqual([{ sector: 'S6', rule: 'r11', count: 3, flag: 'recurring – is the rule or the method wrong?' }]);
    expect((await get(r, '/lessons/report?month=2026-09')).json().sectors[0].top_rules[0].rule).toBe('old');
    const md = await get(r, '/lessons/report?month=2026-10&format=md');
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('## S6 (4)');
    expect(md.body).toContain('recurring');
    expect((await get(r, '/lessons/report?month=2026-13')).statusCode).toBe(400);
    expect((await get(r, '/lessons/report')).statusCode).toBe(400);
  });
});
