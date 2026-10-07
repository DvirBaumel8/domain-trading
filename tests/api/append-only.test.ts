// v2.1.0 (CR-005 N-11b): the append-only guarantee, table by table. The list is the one the evidence map uses.
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { APPEND_ONLY_TABLES } from '../../scripts/evidence.js';
import { testDb as db } from '../helpers/db.js';

describe('append-only tables', () => {
  it('every listed table has row triggers that refuse UPDATE, DELETE and a TRUNCATE trigger (catalog)', async () => {
    const r = await sql<{ tbl: string; ev: number; func: string }>`
      select c.relname as tbl, t.tgtype as ev, p.proname as func
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace`.execute(db);
    const UPDATE = 16, DELETE = 8, TRUNCATE = 32, ROW = 1, BEFORE = 2;
    for (const table of APPEND_ONLY_TABLES) {
      const mine = r.rows.filter((x) => x.tbl === table);
      const has = (bit: number, row: boolean) => mine.some((x) => (x.ev & bit) !== 0 && (x.ev & BEFORE) !== 0 && ((x.ev & ROW) !== 0) === row);
      expect(has(UPDATE, true), `${table}: BEFORE UPDATE row trigger`).toBe(true);
      expect(has(DELETE, true), `${table}: BEFORE DELETE row trigger`).toBe(true);
      expect(has(TRUNCATE, false), `${table}: BEFORE TRUNCATE trigger`).toBe(true);
    }
  });

  it('every listed table refuses UPDATE, DELETE and TRUNCATE (TRUNCATE on every table; the row on job_runs)', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      await expect(sql`TRUNCATE ${sql.table(table)} CASCADE`.execute(db), table).rejects.toThrow(/append-only|not allowed|immutable/i);
    }
    await db.insertInto('job_runs').values({ job: 'tick', trigger: 'manual', started_at: new Date(), finished_at: new Date(), skipped: false, ok: true, steps: '{}' }).execute();
    await expect(db.updateTable('job_runs').set({ ok: false }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('job_runs').execute()).rejects.toThrow(/append-only/);
    expect(await db.selectFrom('job_runs').selectAll().execute()).toHaveLength(1);
  });
});
