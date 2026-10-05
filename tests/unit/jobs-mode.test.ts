import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { poolConfig } from '../../src/db/client.js';
import { startJobScheduling } from '../../src/jobs/schedule.js';
import { testEnv } from '../helpers/env.js';

afterEach(() => vi.useRealTimers());

function fakeApp() {
  const ok = () => ({ runOnce: vi.fn(async () => ({})) });
  const app = {
    reconciler: ok(), nsVerifier: ok(), priceJob: ok(), dropJob: ok(), registrarCheckJob: ok(),
    log: { error: vi.fn() },
  };
  return app as unknown as FastifyInstance & typeof app;
}

describe('startJobScheduling', () => {
  it('external: starts no timers and runs nothing at startup', () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const stop = startJobScheduling(app, loadConfig(testEnv({ JOBS_MODE: 'external' })));
    expect(vi.getTimerCount()).toBe(0);
    for (const j of [app.reconciler, app.nsVerifier, app.priceJob, app.dropJob, app.registrarCheckJob]) expect(j.runOnce).not.toHaveBeenCalled();
    stop();
  });

  it('internal (the default): runs everything at startup and arms the timers', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const cfg = loadConfig(testEnv());
    expect(cfg.jobsMode).toBe('internal');
    const stop = startJobScheduling(app, cfg);
    await vi.advanceTimersByTimeAsync(0);
    for (const j of [app.reconciler, app.nsVerifier, app.priceJob, app.dropJob, app.registrarCheckJob]) expect(j.runOnce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('config', () => {
  it('JOB_TRIGGER_TOKEN: unset → undefined; set → exposed and counted as a secret', () => {
    expect(loadConfig(testEnv()).jobTriggerToken).toBeUndefined();
    const c = loadConfig(testEnv({ JOB_TRIGGER_TOKEN: 'tok_fake_123456' }));
    expect(c.jobTriggerToken).toBe('tok_fake_123456');
    expect(c.secretValues).toContain('tok_fake_123456');
  });

  it('rejects an unknown JOBS_MODE', () => {
    expect(() => loadConfig(testEnv({ JOBS_MODE: 'sometimes' }))).toThrow(/JOBS_MODE/);
  });

  it('H6: a -pooler host is refused in production, with an explanation', () => {
    const url = 'postgres://u:p@ep-cool-123-pooler.eu-central-1.aws.neon.tech/db';
    expect(() => loadConfig(testEnv({ APP_ENV: 'production', DATABASE_URL: url }))).toThrow(/direct.*connection string/s);
    expect(() => loadConfig(testEnv({ APP_ENV: 'production', DATABASE_URL: url }))).toThrow(/session advisory lock/);
  });

  it('H6: the direct host is accepted in production; a pooler host is not checked outside production', () => {
    expect(loadConfig(testEnv({ APP_ENV: 'production', DATABASE_URL: 'postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db' })).appEnv).toBe('production');
    expect(loadConfig(testEnv({ DATABASE_URL: 'postgres://u:p@ep-x-pooler.eu.neon.tech/db' })).appEnv).toBe('test');
  });

  it('DATABASE_SSL: default off; true → databaseSsl; garbage rejected', () => {
    expect(loadConfig(testEnv()).databaseSsl).toBe(false);
    expect(loadConfig(testEnv({ DATABASE_SSL: 'true' })).databaseSsl).toBe(true);
    expect(() => loadConfig(testEnv({ DATABASE_SSL: 'yes' }))).toThrow(/DATABASE_SSL/);
  });
});

describe('poolConfig', () => {
  it('sets ssl { rejectUnauthorized: true } only when asked', () => {
    expect(poolConfig('postgres://u:p@h/db').ssl).toBeUndefined();
    expect(poolConfig('postgres://u:p@h/db', { ssl: false }).ssl).toBeUndefined();
    expect(poolConfig('postgres://u:p@h/db', { ssl: true }).ssl).toEqual({ rejectUnauthorized: true });
  });
});
