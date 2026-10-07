import { describe, expect, it, vi } from 'vitest';

import worker, { triggerJob, TIMEOUT_MS } from './index';

const TOKEN = 'secret-token-abc123';
const env = { API_BASE_URL: 'https://api.example.com', JOB_TRIGGER_TOKEN: TOKEN };
const ok = () => new Response('{}', { status: 200 });

describe('triggerJob', () => {
  it('trims a stored token with a trailing newline (wrangler secret put from echo)', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    await triggerJob('tick', { ...env, JOB_TRIGGER_TOKEN: `${TOKEN}\n` }, 1, fetcher, { error: vi.fn() });
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('posts the job with URL, headers, body and idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const logger = { error: vi.fn() };
    await triggerJob('tick', env, 1700000000000, fetcher, logger);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/jobs/run');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Idempotency-Key': 'tick-1700000000000',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe('{"job":"tick"}');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs non-2xx without throwing or echoing the token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(`bad ${TOKEN}`, { status: 502 }));
    const logger = { error: vi.fn() };
    await expect(triggerJob('daily', env, 1, fetcher, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('jobs-trigger daily returned HTTP 502');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  it('logs a network error and redacts the token', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`reset ${TOKEN}`));
    const logger = { error: vi.fn() };
    await triggerJob('tick', env, 1, fetcher, logger);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  it('aborts after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
          }),
      );
      const logger = { error: vi.fn() };
      const p = triggerJob('tick', env, 1, fetcher, logger);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await p;
      expect(logger.error).toHaveBeenCalledWith(`jobs-trigger tick failed: timed out after ${TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ JOB_TRIGGER_TOKEN: TOKEN }],
    [{ API_BASE_URL: 'https://api.example.com' }],
    [{}],
  ])('refuses missing env %j without a request', async (e) => {
    const fetcher = vi.fn();
    const logger = { error: vi.fn() };
    await triggerJob('tick', e, 1, fetcher, logger);
    expect(fetcher).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  it('refuses a non-https base URL', async () => {
    const fetcher = vi.fn();
    const logger = { error: vi.fn() };
    await triggerJob('tick', { ...env, API_BASE_URL: 'http://api.example.com' }, 1, fetcher, logger);
    expect(fetcher).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled', () => {
  const run = async (cron: string, scheduledTime = 42) => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await worker.scheduled({ cron, scheduledTime } as ScheduledController, env, {} as ExecutionContext);
      return { fetchMock, errSpy: { calls: errSpy.mock.calls.length } };
    } finally {
      vi.unstubAllGlobals();
      errSpy.mockRestore();
    }
  };

  it('runs daily only, at 00:05 UTC', async () => {
    const t = Date.UTC(2026, 9, 7, 0, 5);
    const { fetchMock } = await run('5 0 * * *', t);
    expect(fetchMock.mock.calls.map((c) => c[1].body)).toEqual(['{"job":"daily"}']);
    expect(fetchMock.mock.calls[0]![1].headers['Idempotency-Key']).toBe(`daily-${t}`);
  });

  it('refuses the retired hourly cron (no request)', async () => {
    const { fetchMock, errSpy } = await run('5 * * * *', Date.UTC(2026, 9, 7, 13, 5));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errSpy.calls).toBe(1);
  });

  it('logs an unknown cron and sends nothing', async () => {
    const { fetchMock, errSpy } = await run('5 5 * * *');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errSpy.calls).toBe(1);
  });
});
