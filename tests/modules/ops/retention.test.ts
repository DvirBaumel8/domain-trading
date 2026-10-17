// v5.1.0 (G-95, Dvir 14 Oct 2026): the daily `retention` step. Old data nobody can need again goes; packs, owned names, test sets, cohorts, newest rows stay.
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { RetentionJob } from '../../../src/modules/ops/jobs/retention.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';

const NOW = Date.parse('2027-06-01T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const job = (o: { bytes?: number; limit?: number } = {}) => new RetentionJob({ db, now: () => NOW, dbBytes: async () => o.bytes ?? 1000, storageLimitBytes: o.limit ?? 1_000_000, batchRows: 2 });
const count = async (t: string, where = 'true') => Number((await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)} where ${sql.raw(where)}`.execute(db)).rows[0]!.n);

async function run(id: string, o: { backtest?: boolean; created?: Date } = {}) {
  await sql`insert into screening_runs (id, created_by, mode, backtest, settings_id, settings_label, buy_hold, input, gate_plan, list_versions, status, deadline_at, created_at)
    values (${id}, 'test', 'live', ${o.backtest ?? false}, (select min(id) from selection_settings), 'v', false, '{}', '{}', '{}', 'done', ${ago(1)}, ${o.created ?? ago(400)})`.execute(db);
}
let itemNo = 0;
async function result(runId: string, domain: string, check: string, days: number, evidence: number[] = [], cachedFrom: string | null = null): Promise<string> {
  itemNo += 1;
  const r = await sql<{ id: string }>`insert into screening_results (run_id, item_idx, domain, lane, check_id, gate, rule_ids, status, fields, checked_at, settings_label, list_versions, duration_ms, upstream_calls, evidence_ids, source, cached_from)
    values (${runId}, ${itemNo}, ${domain}, 'S2', ${check}, 'G1', '{}', 'PASS', '{}', ${ago(days)}, 'v', '{}', 0, 0, ${sql.raw(`'{${evidence.join(',')}}'::bigint[]`)}, 'auto', ${cachedFrom}) returning id`.execute(db);
  return String(r.rows[0]!.id);
}
async function evidence(days: number): Promise<number> {
  const r = await sql<{ id: string }>`insert into screening_evidence (source, url, retrieved_at, sha256, text_bytes, truncated, created_at)
    values ('t', 'https://x.example', ${ago(days)}, ${'a'.repeat(64)}, 0, false, ${ago(days)}) returning id`.execute(db);
  return Number(r.rows[0]!.id);
}
async function pack(runId: string, domain: string) {
  await sql`insert into screening_packs (id, domain, version, run_id, item_idx, status, missing, content, content_sha256, settings_label, issued_at, issued_by)
    values ('pk_aaaaaaaaaaaa', ${domain}, 1, ${runId}, 0, 'complete', '[]', '{}', ${'b'.repeat(64)}, 'v', ${ago(300)}, 'test')`.execute(db);
}
const ids = async (t: string) => (await sql<{ id: string }>`select id from ${sql.table(t)} order by id`.execute(db)).rows.map((r) => String(r.id));

describe('RT retention (v5.1.0, G-95)', () => {
  it('RT-1 deletes old unbought results, keeps young ones and the newest per (domain, check); a plain DELETE still fails', async () => {
    await run('r1');
    const oldA = await result('r1', 'oldone.com', 'form', 300);
    await result('r1', 'oldone.com', 'form', 200); // newer, still older than 180 days: the newest of the pair stays
    await result('r1', 'young.com', 'form', 10);
    await result('r1', 'young.com', 'form', 5);
    const s = await job().runOnce();
    expect('tables' in s && s.tables.screening_results).toMatchObject({ deleted: 1, mode: 'normal', days: 180 });
    expect(await ids('screening_results')).not.toContain(oldA);
    expect(await count('screening_results')).toBe(3);
    // the guard: without the retention setting a delete or update is rejected, and TRUNCATE too
    await expect(sql`delete from screening_results`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`update screening_results set reason = 'x'`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`truncate screening_results cascade`.execute(db)).rejects.toThrow(/append-only/);
    await expect(db.transaction().execute(async (t) => { await sql`select set_config('app.retention', 'on', true)`.execute(t); await sql`update screening_results set reason = 'x'`.execute(t); })).rejects.toThrow(/append-only/);
    await expect(db.transaction().execute(async (t) => { await sql`select set_config('app.retention', 'off', true)`.execute(t); await sql`delete from screening_results`.execute(t); })).rejects.toThrow(/append-only/);
    expect(await count('screening_results')).toBe(3);
  });

  it('RT-2 keeps results of owned names, names with a pack, the pack run, test-set, cohort and backtest runs, verdict-bound and cached-from rows', async () => {
    await insertOwnedDomain(db, { domain: 'owned.com' });
    await run('rp'); await run('rts'); await run('rco'); await run('rbt', { backtest: true }); await run('rx');
    await result('rx', 'owned.com', 'form', 300); await result('rx', 'owned.com', 'form', 250);
    await result('rx', 'packed.com', 'form', 300); await result('rx', 'packed.com', 'form', 250);
    await pack('rp', 'packed.com');
    await result('rp', 'otherinpack.com', 'form', 300); await result('rp', 'otherinpack.com', 'form', 250); // same run as a pack
    await sql`insert into test_sets (name, purpose, run_id, created_by, status) values ('TS-ONE', 'new', 'rts', 'test', 'ready')`.execute(db);
    await result('rts', 'inset.com', 'form', 300); await result('rts', 'inset.com', 'form', 250);
    await sql`insert into cohorts (name, created_by, settings_labels, source, run_id, status) values ('co-one', 'test', '{v}', '{}', 'rco', 'frozen')`.execute(db);
    await result('rco', 'incohort.com', 'form', 300); await result('rco', 'incohort.com', 'form', 250);
    await result('rbt', 'backtest.com', 'form', 300); await result('rbt', 'backtest.com', 'form', 250);
    const bound = await result('rx', 'verdict.com', 'form', 300); await result('rx', 'verdict.com', 'form', 250);
    await sql`insert into screening_verdicts (run_id, item_idx, result_id, check_id, domain, verdict, reason, decided_by, decided_at, recorded_by)
      select 'rx', item_idx, id, 'form', 'verdict.com', 'PASS', 'ok', 'test', now(), 'test' from screening_results where id = ${bound}`.execute(db);
    const cachedSrc = await result('rx', 'cache.com', 'form', 300);
    await result('rx', 'cache.com', 'form', 250, [], cachedSrc);
    await job().runOnce();
    // every old row above is protected (the newer cache row points at the older one, so both stay)
    for (const d of ['owned.com', 'packed.com', 'otherinpack.com', 'inset.com', 'incohort.com', 'backtest.com', 'verdict.com', 'cache.com']) expect(await count('screening_results', `domain = '${d}' and checked_at < '${ago(280).toISOString()}'`)).toBe(1);
    expect(await count('screening_results')).toBe(16);
  });

  it('RT-3 evidence: old unreferenced goes; referenced by a result, a sibling scan or an rdap lookup stays; young stays', async () => {
    await run('r1');
    const free = await evidence(300);
    const byResult = await evidence(300);
    const bySibling = await evidence(300);
    const byRdap = await evidence(300);
    const young = await evidence(10);
    await result('r1', 'keep.com', 'form', 5, [byResult]);
    await sql`insert into sibling_scans (domain, fetched_at, settings_label, siblings, lead_points, complete, upstream_calls, evidence_ids, recorded_by)
      values ('keep.com', ${ago(5)}, 'v', '[]', '{}', true, 0, ${JSON.stringify([bySibling])}::jsonb, 'test')`.execute(db);
    await sql`insert into rdap_lookups (domain, outcome, evidence_id, checked_at) values ('keep.com', 'registered', ${byRdap}, ${ago(5)})`.execute(db);
    const s = await job().runOnce();
    expect('tables' in s && s.tables.screening_evidence!.deleted).toBe(1);
    const left = (await ids('screening_evidence')).map(Number);
    expect(left).not.toContain(free);
    expect(left.sort()).toEqual([byResult, bySibling, byRdap, young].sort());
  });

  it('RT-4 empty finished runs go with their candidate_screenings; runs with results, packs, backtests or young runs stay', async () => {
    await run('empty'); await run('withres'); await run('young', { created: ago(5) }); await run('bt', { backtest: true });
    await sql`insert into candidate_screenings (domain, origin, run_id, day) values ('a.com', 'intake', 'empty', '2026-01-01')`.execute(db);
    await result('withres', 'z.com', 'form', 5);
    await job().runOnce();
    expect(await ids('screening_runs')).toEqual(['bt', 'withres', 'young']);
    expect(await count('candidate_screenings')).toBe(0);
  });

  it('RT-5 sibling scans and registrar checks: newest per domain stays, old ones go past 90 days', async () => {
    for (const d of [200, 150, 5]) {
      await sql`insert into sibling_scans (domain, fetched_at, settings_label, siblings, lead_points, complete, upstream_calls, recorded_by) values ('a.com', ${ago(d)}, 'v', '[]', '{}', true, 0, 'test')`.execute(db);
      await sql`insert into registrar_state_checks (domain, checked_at) values ('a.com', ${ago(d)})`.execute(db);
    }
    await sql`insert into sibling_scans (domain, fetched_at, settings_label, siblings, lead_points, complete, upstream_calls, recorded_by) values ('b.com', ${ago(400)}, 'v', '[]', '{}', true, 0, 'test')`.execute(db);
    await sql`insert into registrar_state_checks (domain, checked_at) values ('b.com', ${ago(400)})`.execute(db);
    await sql`insert into registrar_state_checks (domain, checked_at) values ('c.com', ${ago(60)}), ('c.com', ${ago(50)})`.execute(db);
    await job().runOnce();
    expect(await count('sibling_scans', "domain = 'a.com'")).toBe(1);
    expect(await count('sibling_scans', "domain = 'b.com'")).toBe(1);
    expect(await count('registrar_state_checks', "domain = 'a.com'")).toBe(1);
    expect(await count('registrar_state_checks', "domain = 'b.com'")).toBe(1);
    expect(await count('registrar_state_checks', "domain = 'c.com'")).toBe(2);
  });

  it('RT-6 quotes: old ones go unless a purchase names the check or it is the newest check of the name; job logs past 60 days go', async () => {
    const q = (check: string, domain: string, days: number) => sql`insert into quotes (check_id, domain, registrar, quoted_at, eligible) values (${check}, ${domain}, 'porkbun', ${ago(days)}, true)`.execute(db);
    await q('c-old', 'a.com', 300); await q('c-bought', 'b.com', 300); await q('c-new', 'a.com', 250); await q('c-newer', 'a.com', 10);
    await sql`insert into purchases (idempotency_key, request_hash, domain, state, max_price_cents, approval_text, approval_at, check_id) values ('k', 'h', 'b.com', 'failed', 1000, 'ok b.com', ${ago(299)}, 'c-bought')`.execute(db);
    await q('c-bnew', 'b.com', 280);
    await sql`insert into job_queue_runs (id, job, trigger, created_at) values ('old', 'daily', 'scheduled', ${ago(90)}), ('new', 'daily', 'scheduled', ${ago(2)})`.execute(db);
    await sql`insert into job_steps (run_id, job, step, position, max_attempts, timeout_ms, created_at, status) values ('old', 'daily', 's', 1, 1, 1000, ${ago(90)}, 'done'), ('new', 'daily', 's', 1, 1, 1000, ${ago(2)}, 'done')`.execute(db);
    await sql`insert into job_runs (job, trigger, started_at, finished_at, skipped, ok, steps) values ('daily', 'scheduled', ${ago(91)}, ${ago(90)}, false, true, '{}'), ('daily', 'scheduled', ${ago(2)}, ${ago(2)}, false, true, '{}')`.execute(db);
    await job().runOnce();
    expect((await sql<{ check_id: string }>`select check_id from quotes order by id`.execute(db)).rows.map((r) => r.check_id)).toEqual(['c-bought', 'c-newer', 'c-bnew']);
    expect(await ids('job_queue_runs')).toEqual(['new']);
    expect(await count('job_steps')).toBe(1);
    expect(await count('job_runs')).toBe(1);
  });

  it('RT-7 tight mode halves the ages when the database is at 70% of the limit; normal mode below', async () => {
    await run('r1');
    await result('r1', 'a.com', 'form', 120); await result('r1', 'a.com', 'form', 100); // 120 days old: kept at 180, deleted at 90
    const normal = await job({ bytes: 600_000 }).runOnce();
    expect(normal).toMatchObject({ mode: 'normal' });
    expect(await count('screening_results')).toBe(2);
    const tight = await job({ bytes: 700_000 }).runOnce();
    expect(tight).toMatchObject({ mode: 'tight', db_bytes_before: 700_000 });
    expect('tables' in tight && tight.tables.screening_results).toMatchObject({ deleted: 1, mode: 'tight', days: 90 });
    expect(await count('screening_results')).toBe(1);
  });

  it('RT-8 dry run counts and deletes nothing; the batch loop and the time budget', async () => {
    await run('r1');
    for (let i = 0; i < 5; i++) { await result('r1', `d${i}.com`, 'form', 300); await result('r1', `d${i}.com`, 'form', 5); }
    const dry = await job().runOnce({ dryRun: true });
    expect(dry).toMatchObject({ dry_run: true });
    expect('tables' in dry && dry.tables.screening_results!.deleted).toBe(5);
    expect(await count('screening_results')).toBe(10);
    const real = await job().runOnce(); // batch of 2: three batches
    expect('tables' in real && real.tables.screening_results!.deleted).toBe(5);
    expect(await count('screening_results')).toBe(5);
    await run('r2'); await result('r2', 'e.com', 'form', 300); await result('r2', 'e.com', 'form', 5);
    const none = await new RetentionJob({ db, now: () => NOW, dbBytes: async () => 1, timeBudgetMs: 0 }).runOnce();
    expect(none).toMatchObject({ partial: true });
    expect(await count('screening_results')).toBe(7);
  });

  it('RT-9 never touches audit_log, ledger_entries or screening_packs', async () => {
    await run('r1'); await pack('r1', 'p.com');
    await sql`insert into audit_log (id, at, token_name, scope, method, path, request, status) values ('au1', ${ago(900)}, 't', 'write', 'POST', '/x', '{}', 200)`.execute(db).catch(() => undefined);
    const before = [await count('audit_log'), await count('ledger_entries'), await count('screening_packs')];
    await job({ bytes: 900_000 }).runOnce();
    expect([await count('audit_log'), await count('ledger_entries'), await count('screening_packs')]).toEqual(before);
    expect(await count('screening_runs', "id = 'r1'")).toBe(1);
  });
  it('RT-10 drop lists (v5.14.0, D3): a list more than 90 days past its list_date goes with its rows and checks; a younger list stays whole; tight mode uses 60 days', async () => {
    const day = (d: number) => ago(d).toISOString().slice(0, 10);
    for (const [name, age] of [['old-list', 200], ['mid-list', 70], ['new-list', 10]] as const) {
      await sql`insert into drop_lists (name, list_date, created_at, created_by, received_n, kept_n) values (${name}, ${day(age)}::date, ${ago(age)}, 'test', 2, 2)`.execute(db);
      await sql`insert into drop_list_rows (list_name, domain, kept) values (${name}, ${name + '-a.com'}, true), (${name}, ${name + '-b.com'}, false)`.execute(db);
      await sql`insert into drop_list_checks (list_name, domain, checked_at, status) values (${name}, ${name + '-a.com'}, ${ago(age)}, 'registered')`.execute(db);
    }
    const dry = await job().runOnce({ dryRun: true });
    expect('tables' in dry && [dry.tables.drop_list_checks!.deleted, dry.tables.drop_list_rows!.deleted, dry.tables.drop_lists!.deleted]).toEqual([1, 2, 0]) // the list itself is counted once its rows are gone;
    expect(await count('drop_lists')).toBe(3);
    const s = await job().runOnce();
    expect('tables' in s && s.tables.drop_lists).toMatchObject({ deleted: 1, days: 90 });
    expect(await count('drop_lists', "name = 'old-list'")).toBe(0);
    expect(await count('drop_list_rows', "list_name = 'old-list'")).toBe(0);
    expect(await count('drop_list_checks', "list_name = 'old-list'")).toBe(0);
    expect(await count('drop_list_rows')).toBe(4);
    const tight = await job({ bytes: 800_000 }).runOnce();
    expect('tables' in tight && tight.tables.drop_lists).toMatchObject({ deleted: 1, mode: 'tight', days: 60 });
    expect(await count('drop_lists')).toBe(1);
    await expect(sql`delete from drop_lists`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('RT-11 daily candidate lists keep the newest and the last 90 days; NameBio call counters go past 30 days; listing-sync log keeps the newest per (domain, venue, action)', async () => {
    const dl = (d: number) => sql`insert into daily_candidate_lists (day, built_at, entries, sections, summary) values (${ago(d).toISOString().slice(0, 10)}::date, ${ago(d)}, '[]', '{}', '{}')`.execute(db);
    await dl(400); await dl(300); await dl(100); await dl(5);
    await sql`insert into namebio_calls (kind, called_at) values ('retailstats', ${ago(40)}), ('retailstats', ${ago(1)})`.execute(db);
    const ls = (domain: string, action: string, d: number) => sql`insert into listing_sync_log (domain, venue, action, at) values (${domain}, 'sellerhub', ${action}, ${ago(d)})`.execute(db);
    await ls('a.com', 'sold_seen', 400); await ls('a.com', 'sold_seen', 300); await ls('a.com', 'update', 300); await ls('b.com', 'sold_seen', 10);
    const s = await job().runOnce();
    expect('tables' in s && [s.tables.daily_candidate_lists!.deleted, s.tables.namebio_calls!.deleted, s.tables.listing_sync_log!.deleted]).toEqual([3, 1, 1]);
    expect(await count('daily_candidate_lists')).toBe(1);
    expect(await count('namebio_calls')).toBe(1);
    expect(await count('listing_sync_log')).toBe(3);
    // only the newest list is kept even when it is old
    await sql`delete from daily_candidate_lists where false`.execute(db);
    const t = await new RetentionJob({ db, now: () => NOW + 500 * 86_400_000, dbBytes: async () => 1 }).runOnce();
    expect('tables' in t && t.tables.daily_candidate_lists!.deleted).toBe(0);
    expect(await count('daily_candidate_lists')).toBe(1);
  });

  it('RT-12 evidence: the referenced set is a temp table built once per run and dropped afterwards (the same answer over many batches)', async () => {
    await run('r1');
    const keep = await evidence(300);
    await result('r1', 'k.com', 'form', 5, [keep]);
    for (let i = 0; i < 7; i++) await evidence(300);
    const s = await job().runOnce(); // batch of 2: four evidence batches
    expect('tables' in s && s.tables.screening_evidence!.deleted).toBe(7);
    expect((await ids('screening_evidence')).map(Number)).toEqual([keep]);
    const gone = await sql<{ r: string | null }>`select to_regclass('pg_temp.retention_evidence_refs')::text as r`.execute(db);
    expect(gone.rows[0]!.r).toBeNull();
  });
});
