import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run('npx', ['tsx', 'src/job.ts', ...args], { env: { ...process.env, ...testEnv() } });

describe('job CLI', () => {
  it('price-schedule --dry-run prints JSON and exits 0', async () => {
    const { stdout } = await cli(['price-schedule', '--dry-run', '--today', '2027-04-12']);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, today: '2027-04-12' });
    expect(stdout).toContain('"dryRun": true');
    for (const secret of ['pk1_', 'sk1_']) expect(stdout).not.toContain(secret);
  });

  it('bad --today, no subcommand and unknown subcommand exit 2', async () => {
    await expect(cli(['price-schedule', '--today', '2027-13-01'])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['price-schedule', '--today', '2999-01-01'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('only allowed with --dry-run') });
    await expect(cli([])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['nope'])).rejects.toMatchObject({ code: 2 });
  });
});

describe('job CLI drop', () => {
  it('drop --dry-run --today exits 0 and prints JSON; the future-today guard applies', async () => {
    const { stdout } = await cli(['drop', '--dry-run', '--today', '2028-10-05']);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, today: '2028-10-05', dropped: [] });
    await expect(cli(['drop', '--today', '2999-01-01'])).rejects.toMatchObject({ code: 2 });
  });
});

describe('job CLI tick and daily (the shared JobRunner)', () => {
  it('tick prints the runner result and exits 0', async () => {
    const { stdout } = await cli(['tick']);
    const r = JSON.parse(stdout);
    expect(r).toMatchObject({ job: 'tick', skipped: false });
    expect(Object.keys(r.steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume']);
  });

  it('daily runs every step; the unconfigured backup step is skipped, not failed', async () => {
    // The CLI is a real process (no MSW): switch every outside source off so the reference refresh makes no request.
    const { testDb: tdb } = await import('../helpers/db.js');
    const cur = await tdb.selectFrom('selection_settings').selectAll().orderBy('activation_seq', 'desc').limit(1).executeTakeFirstOrThrow();
    const values = cur.values as { sources: Record<string, boolean> };
    const off = Object.fromEntries(Object.keys(values.sources).map((k) => [k, false]));
    const { id: _id, ...rest } = cur;
    await tdb.insertInto('selection_settings').values({ ...rest, label: 'v1off', values: JSON.stringify({ ...values, sources: off }), based_on_id: cur.id, activation_seq: (cur.activation_seq ?? 0) + 1 }).execute();
    const { stdout } = await cli(['daily']);
    const r = JSON.parse(stdout);
    expect(Object.keys(r.steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'priceJob', 'dropJob', 'registrarCheck', 'referenceRefresh', 'backupExport']);
    expect(r.steps.referenceRefresh).toMatchObject({ ok: true, summary: { popularity: { skipped: true, reason: 'SOURCE_DISABLED' }, iana: { skipped: true }, errors: [] } });
    expect(r.steps.backupExport).toMatchObject({ ok: true, skipped: true });
    const { testDb } = await import('../helpers/db.js');
    const a = await testDb.selectFrom('audit_log').selectAll().where('path', '=', 'job daily').orderBy('at', 'desc').executeTakeFirstOrThrow();
    expect(a).toMatchObject({ scope: 'job', method: 'CLI', status_code: 200, result_summary: 'daily: ok' });
    expect((a.request as { steps: Record<string, string> }).steps.backupExport).toBe('skipped');
  });

  it('extra arguments and --dry-run exit 2', async () => {
    await expect(cli(['tick', 'x'])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['daily', '--dry-run'])).rejects.toMatchObject({ code: 2 });
  });
});
