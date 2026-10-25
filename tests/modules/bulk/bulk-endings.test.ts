// v5.42.0 (G-124): the endings answers are written in batches with the v5.14.0 keep / update / append rule, exactly as saveAnswer writes them one by one.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withDbScope } from '../../../src/core/db-stats.js';
import { type Answer, EndingsWriter, type Pair, saveAnswer } from '../../../src/modules/engine/endings.js';
import { testDb as db } from '../../helpers/db.js';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const T1 = Date.parse('2026-10-25T10:00:00Z');
const ans = (registered: boolean | null, created: string | null = null, registrar: string | null = null): Answer => ({
  registered, createdAt: created ? new Date(created) : null, httpStatus: registered === null ? null : registered ? 200 : 404, reason: registered === null ? 'TIMEOUT' : null,
  evidence: registered === null ? null : { host: 'rdap.example', registrar },
});
const rowsOf = async (name: string) => db.selectFrom('engine_endings').selectAll().where('name', '=', name).orderBy('id').execute();

describe('BK542 bulk writes: endings', () => {
  it('BK542-8 600 answers take fewer than 10 queries and leave the same rows as saveAnswer one by one (unanswered updated, same answer updated in place, changed appended, unanswered ask keeps)', async () => {
    // fixtures: for each scenario 100 names x 2 sets (batch set "b..", one-by-one set "s..") so both paths start from the same rows
    const scenarios = ['new', 'unanswered', 'same', 'changed', 'keep', 'newer'] as const;
    const pairs: Array<{ set: 'b' | 's'; kind: (typeof scenarios)[number]; p: Pair; a: Answer }> = [];
    for (const set of ['b', 's'] as const) {
      for (const kind of scenarios) {
        for (let i = 0; i < 100; i++) {
          const name = `${set}${kind}${i}`;
          const prior = kind === 'new' ? null : kind === 'unanswered' ? ans(null) : ans(true, '2020-01-01T00:00:00Z', 'Old');
          let id: number | null = null;
          if (prior) {
            const row = await db.insertInto('engine_endings').values({
              name, tld: 'net', registered: prior.registered, created_at_registry: prior.createdAt, checked_at: new Date(kind === 'newer' ? T1 + 1000 : T0), http_status: prior.httpStatus, reason_code: prior.reason,
              evidence: prior.evidence ? JSON.stringify(prior.evidence) : null, registrar: null,
            }).returning('id').executeTakeFirstOrThrow();
            id = row.id;
          }
          const a = kind === 'new' ? ans(true, '2024-01-01T00:00:00Z', 'R') : kind === 'unanswered' ? ans(false) : kind === 'same' ? ans(true, '2020-01-01T00:00:00Z', 'New') : kind === 'changed' ? ans(true, '2025-05-05T00:00:00Z') : kind === 'keep' ? ans(null) : ans(true, '2020-01-01T00:00:00Z', 'Stale');
          pairs.push({ set, kind, p: { name, tld: 'net', prevId: id, prevRegistered: prior ? prior.registered : null }, a });
        }
      }
    }
    const single = await withDbScope('bk542-8-single', async () => { for (const x of pairs.filter((y) => y.set === 's')) await saveAnswer(db, T1, x.p, x.a); });
    if (process.env.BK_LOG) appendFileSync(process.env.BK_LOG, `BK542-8 one by one (before): ${single.stats.queries}\n`);
    expect(single.stats.queries).toBeGreaterThan(500);
    const w = new EndingsWriter(db, 500);
    const { stats } = await withDbScope('bk542-8', async () => {
      for (const x of pairs.filter((y) => y.set === 'b')) await w.add(T1, x.p, x.a);
      await w.flush();
    });
    if (process.env.BK_LOG) appendFileSync(process.env.BK_LOG, `BK542-8: ${stats.queries}\n`);
    expect(stats.queries).toBeLessThan(10); // before 5.42.0 (saveAnswer one by one): about 700 for the same answers
    expect(w.inserted + w.updated).toBe(100 + 100 + 100 + 100 + 0 + 0 + 100);
    for (const kind of scenarios) {
      for (let i = 0; i < 100; i += 33) {
        const b = await rowsOf(`b${kind}${i}`);
        const s = await rowsOf(`s${kind}${i}`);
        const strip = (rows: typeof b) => rows.map(({ id: _id, name: _n, ...rest }) => rest);
        expect(strip(b), `${kind} ${i}`).toEqual(strip(s));
      }
    }
    expect((await rowsOf('bchanged1'))).toHaveLength(2); // appended
    expect((await rowsOf('bsame1'))).toHaveLength(1); // in place
    expect((await rowsOf('bkeep1'))[0]).toMatchObject({ registered: true }); // the known answer stays
    expect((await rowsOf('bnewer1'))[0]!.checked_at.getTime()).toBe(T1 + 1000); // an older ask never overwrites a newer row; it appends
  });
});
