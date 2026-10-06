import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import pg from 'pg';
import { poolConfig } from '../../src/db/client.js';
import { JobRunner } from '../../src/jobs/runner.js';
import { BackupExporter } from '../../src/jobs/backup-export.js';
import { testEnv } from '../helpers/env.js';

function fakeApp(backupExport?: { runOnce(): Promise<unknown> }) {
  const ok = () => ({ runOnce: vi.fn(async () => ({})) });
  const jobs = { reconciler: ok(), nsVerifier: ok(), priceJob: ok(), dropJob: ok(), registrarCheckJob: ok() };
  // The real runner (the one POST /jobs/run uses); only its jobs are fakes. db is unused by `daily`.
  const jobRunner = new JobRunner({ db: undefined as never, now: Date.now, ...jobs, screeningWorker: { resumeStalled: vi.fn(async () => ({})) }, backupExport });
  return { ...jobs, jobRunner };
}

describe('npm run job -- daily (the shared runner)', () => {
  it('runs price, drop, registrar check, backup export in order through app.jobRunner', async () => {
    const order: string[] = [];
    const backup = { runOnce: vi.fn(async () => { order.push('backup'); return {}; }) };
    const app = fakeApp(backup);
    const run = vi.spyOn(app.jobRunner, 'run');
    for (const [k, j] of [['price', app.priceJob], ['drop', app.dropJob], ['registrar', app.registrarCheckJob]] as const) {
      j.runOnce.mockImplementation(async () => { order.push(k); return {}; });
    }
    await app.jobRunner.run('daily');
    expect(order).toEqual(['price', 'drop', 'registrar', 'backup']);
  });

  it('with no backup token or repo the backup step is skipped and one warn line is logged', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    const exporter = new BackupExporter({
      db: undefined as never, config: { backup: { token: undefined, repo: undefined } }, now: Date.now, log: { warn: (m) => warn.push(m), info: (m) => info.push(m) },
    });
    const app = fakeApp(exporter);
    const run = vi.spyOn(app.jobRunner, 'run');
    await app.jobRunner.run('daily');
    expect((await run.mock.results[0]!.value).steps.backupExport).toMatchObject({ ok: true, skipped: true });
    expect(warn).toEqual(['backup export skipped: GITHUB_BACKUP_TOKEN/GITHUB_BACKUP_REPO not set']);
    expect(info).toEqual([]);
  });
});

describe('config', () => {
  it('JOB_TRIGGER_TOKEN: unset → undefined; set → exposed and counted as a secret', () => {
    expect(loadConfig(testEnv()).jobTriggerToken).toBeUndefined();
    const c = loadConfig(testEnv({ JOB_TRIGGER_TOKEN: 'tok_fake_0123456789abcdef0123456789abcdef' }));
    expect(c.jobTriggerToken).toBe('tok_fake_0123456789abcdef0123456789abcdef');
    expect(c.secretValues).toContain('tok_fake_0123456789abcdef0123456789abcdef');
  });

  it('H6: a -pooler host is refused in production, with an explanation', () => {
    const url = 'postgres://u:p@ep-cool-123-pooler.eu-central-1.aws.neon.tech/db';
    expect(() => loadConfig(testEnv({ APP_ENV: 'production', DATABASE_URL: url }))).toThrow(/direct.*connection string/s);
    expect(() => loadConfig(testEnv({ APP_ENV: 'production', DATABASE_URL: url }))).toThrow(/session advisory lock/);
  });

  it('H6: the direct host is accepted in production; a pooler host is not checked outside production', () => {
    // Spec change (2d6dbaf): production also needs DATABASE_SSL=true and sslmode=verify-full, so this URL now carries them.
    expect(loadConfig(testEnv({ APP_ENV: 'production', DATABASE_SSL: 'true', DATABASE_URL: 'postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db?sslmode=verify-full' })).appEnv).toBe('production');
    expect(loadConfig(testEnv({ DATABASE_URL: 'postgres://u:p@ep-x-pooler.eu.neon.tech/db' })).appEnv).toBe('test');
  });

  it('DATABASE_SSL: default off; true → databaseSsl; garbage rejected', () => {
    expect(loadConfig(testEnv()).databaseSsl).toBe(false);
    expect(loadConfig(testEnv({ DATABASE_SSL: 'true' })).databaseSsl).toBe(true);
    expect(() => loadConfig(testEnv({ DATABASE_SSL: 'yes' }))).toThrow(/DATABASE_SSL/);
  });
});

describe('JOB_TRIGGER_TOKEN format', () => {
  it('rejects short or whitespace tokens; empty counts as unset', () => {
    expect(() => loadConfig(testEnv({ JOB_TRIGGER_TOKEN: 'short' }))).toThrow(/JOB_TRIGGER_TOKEN/);
    expect(() => loadConfig(testEnv({ JOB_TRIGGER_TOKEN: `${'a'.repeat(20)} ${'b'.repeat(20)}` }))).toThrow(/JOB_TRIGGER_TOKEN/);
    expect(loadConfig(testEnv({ JOB_TRIGGER_TOKEN: '' })).jobTriggerToken).toBeUndefined();
    expect(loadConfig(testEnv({ JOB_TRIGGER_TOKEN: 'a'.repeat(32) })).jobTriggerToken).toBe('a'.repeat(32));
  });
});

describe('DATABASE_SSL vs sslmode in the URL (effective pg config)', () => {
  const effective = (url: string) => (new pg.Client(poolConfig(url, { ssl: true })) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
  it.each([
    'postgres://u:p@h/db', 'postgres://u:p@h/db?sslmode=require', 'postgres://u:p@h/db?sslmode=verify-full',
    'postgres://u:p@h/db?application_name=x&sslmode=require',
  ])('%s → verified TLS', (url) => {
    expect(effective(url)).toEqual({ rejectUnauthorized: true });
  });
  it('strips sslmode but keeps other parameters', () => {
    expect(poolConfig('postgres://u:p@h/db?sslmode=require&application_name=x', { ssl: true }).connectionString).toBe('postgres://u:p@h/db?application_name=x');
  });
  it.each(['disable', 'no-verify', 'prefer', 'allow'])('sslmode=%s is refused', (m) => {
    expect(() => loadConfig(testEnv({ DATABASE_SSL: 'true', DATABASE_URL: `postgres://u:p@h/db?sslmode=${m}` }))).toThrow(/sslmode/);
  });
  it('without DATABASE_SSL the URL is untouched', () => {
    expect(poolConfig('postgres://u:p@h/db?sslmode=disable').connectionString).toBe('postgres://u:p@h/db?sslmode=disable');
    expect(loadConfig(testEnv({ DATABASE_URL: 'postgres://u:p@h/db?sslmode=disable' })).databaseSsl).toBe(false);
  });
});

describe('poolConfig', () => {
  it('sets ssl { rejectUnauthorized: true } only when asked', () => {
    expect(poolConfig('postgres://u:p@h/db').ssl).toBeUndefined();
    expect(poolConfig('postgres://u:p@h/db', { ssl: false }).ssl).toBeUndefined();
    expect(poolConfig('postgres://u:p@h/db', { ssl: true }).ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('DB TLS: production requires sslmode=verify-full', () => {
  const prod = (url: string, ssl: string | null = 'true') =>
    testEnv({ APP_ENV: 'production', DATABASE_URL: url, ...(ssl === null ? {} : { DATABASE_SSL: ssl }) });
  const effective = (url: string) => (new pg.Client(poolConfig(url, { ssl: true })) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
  const GOOD = 'postgres://u:p@ep-x.eu.neon.tech/db?sslmode=verify-full';

  it('production + verify-full → ok, and the effective pg config verifies the certificate', () => {
    const c = loadConfig(prod(GOOD));
    expect(c.databaseSsl).toBe(true);
    expect(effective(c.databaseUrl)).toEqual({ rejectUnauthorized: true });
  });
  it('production + require → refused, naming the fix', () => {
    expect(() => loadConfig(prod('postgres://u:p@ep-x.eu.neon.tech/db?sslmode=require'))).toThrow(/Neon direct string with \?sslmode=verify-full/);
  });
  it.each(['disable', 'prefer', 'no-verify'])('production + sslmode=%s → refused', (m) => {
    expect(() => loadConfig(prod(`postgres://u:p@ep-x.eu.neon.tech/db?sslmode=${m}`))).toThrow(/verify-full/);
  });
  it('production + no sslmode → refused', () => {
    expect(() => loadConfig(prod('postgres://u:p@ep-x.eu.neon.tech/db'))).toThrow(/verify-full/);
  });
  it('production + DATABASE_SSL unset or false → refused', () => {
    expect(() => loadConfig(prod(GOOD, null))).toThrow(/DATABASE_SSL=true/);
    expect(() => loadConfig(prod(GOOD, 'false'))).toThrow(/DATABASE_SSL=true/);
  });
  it('non-production + require → accepted', () => {
    expect(loadConfig(testEnv({ DATABASE_SSL: 'true', DATABASE_URL: 'postgres://u:p@h/db?sslmode=require' })).databaseSsl).toBe(true);
  });
});
