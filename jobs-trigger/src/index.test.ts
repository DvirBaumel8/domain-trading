import { describe, expect, it, vi } from 'vitest';

import worker, { triggerJob, TIMEOUT_MS, WAKE_TIMEOUT_MS, RETRY_DELAY_MS } from './index';

const TOKEN = 'secret-token-abc123';
const env = { API_BASE_URL: 'https://api.example.com', JOB_TRIGGER_TOKEN: TOKEN };
const ok = () => new Response('{}', { status: 200 });
const fast = { sleep: async () => {} };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const posts = (f: { mock: { calls: any[][] } }): any[][] => f.mock.calls.filter((c) => c[1].method === 'POST');

describe('triggerJob', () => {
  it('trims a stored token with a trailing newline (wrangler secret put from echo)', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    await triggerJob('tick', { ...env, JOB_TRIGGER_TOKEN: `${TOKEN}\n` }, 1, fetcher, { error: vi.fn() }, fast);
    expect(posts(fetcher)[0]![1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('posts the job with URL, headers, body and idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok());
    const logger = { error: vi.fn() };
    await triggerJob('tick', env, 1700000000000, fetcher, logger, fast);
    expect(fetcher).toHaveBeenCalledTimes(2); // the wake-up ping, then the POST
    const [url, init] = posts(fetcher)[0]!;
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
    await expect(triggerJob('daily', env, 1, fetcher, logger, fast)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('jobs-trigger daily returned HTTP 502');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  it('logs a network error and redacts the token', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`reset ${TOKEN}`));
    const logger = { error: vi.fn() };
    await triggerJob('tick', env, 1, fetcher, logger, fast);
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
      const p = triggerJob('tick', env, 1, fetcher, logger, fast);
      await vi.advanceTimersByTimeAsync(WAKE_TIMEOUT_MS + 2 * TIMEOUT_MS + RETRY_DELAY_MS);
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

describe('wake-up, retry and failed steps', () => {
  it('pings /health/ping first, and posts even when the ping fails', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('cold'))
      .mockResolvedValueOnce(ok());
    const logger = { error: vi.fn() };
    await triggerJob('daily', env, 1, fetcher, logger, fast);
    expect(fetcher.mock.calls.map((c) => [c[0], c[1].method])).toEqual([['https://api.example.com/health/ping', 'GET'], ['https://api.example.com/jobs/run', 'POST']]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('retries the POST once after a network error or a 5xx (same idempotency key); a success then logs nothing', async () => {
    for (const first of [new Error('reset'), new Response('x', { status: 503 })]) {
      const fetcher = vi.fn().mockResolvedValueOnce(ok());
      if (first instanceof Error) fetcher.mockRejectedValueOnce(first); else fetcher.mockResolvedValueOnce(first);
      fetcher.mockResolvedValueOnce(ok());
      const logger = { error: vi.fn() };
      const sleep = vi.fn().mockResolvedValue(undefined);
      await triggerJob('daily', env, 7, fetcher, logger, { sleep });
      expect(sleep).toHaveBeenCalledWith(RETRY_DELAY_MS);
      expect(posts(fetcher).map((c) => (c[1] as { headers: Record<string, string> }).headers['Idempotency-Key'])).toEqual(['daily-7', 'daily-7']);
      expect(logger.error).not.toHaveBeenCalled();
    }
  });

  it('does not retry a 4xx; a 5xx twice is logged once', async () => {
    const f4 = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    const l4 = { error: vi.fn() };
    await triggerJob('daily', env, 1, f4, l4, fast);
    expect(posts(f4)).toHaveLength(1);
    expect(l4.error).toHaveBeenCalledWith('jobs-trigger daily returned HTTP 401');
    const f5 = vi.fn().mockResolvedValue(new Response('no', { status: 500 }));
    const l5 = { error: vi.fn() };
    await triggerJob('daily', env, 1, f5, l5, fast);
    expect(posts(f5)).toHaveLength(2);
    expect(l5.error).toHaveBeenCalledTimes(1);
  });

  it('accepts 202 and logs the run id (info); an overlap says it is already queued or running; an unreadable 202 body logs no error', async () => {
    const queued = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ run_id: 'run_abc', job: 'daily', status: 'queued', skipped: false, steps: ['a'] }), { status: 202 }));
    const logger = { error: vi.fn(), info: vi.fn() };
    await triggerJob('daily', env, 1, queued, logger, fast);
    expect(posts(queued)).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('jobs-trigger daily: queued run run_abc');
    const dup = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ run_id: 'run_abc', skipped: true }), { status: 202 }));
    const l2 = { error: vi.fn(), info: vi.fn() };
    await triggerJob('daily', env, 1, dup, l2, fast);
    expect(l2.info).toHaveBeenCalledWith('jobs-trigger daily: already queued or running, run run_abc');
    const junk = vi.fn().mockImplementation(async () => new Response('not json', { status: 202 }));
    const l3 = { error: vi.fn(), info: vi.fn() };
    await triggerJob('daily', env, 1, junk, l3, fast);
    expect(l3.error).not.toHaveBeenCalled();
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

  it('does not schedule the tick (the GitHub workflow runs it at 08:30 UTC), the old 07:30 cron included', async () => {
    for (const cron of ['30 7 * * *', '30 8 * * *']) {
      const { fetchMock, errSpy } = await run(cron, Date.UTC(2026, 9, 7, 8, 30));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errSpy.calls).toBe(1);
    }
  });

  it('runs daily only, at 00:05 UTC', async () => {
    const t = Date.UTC(2026, 9, 7, 0, 5);
    const { fetchMock } = await run('5 0 * * *', t);
    expect(posts(fetchMock).map((c) => (c[1] as RequestInit).body)).toEqual(['{"job":"daily"}']);
    expect((posts(fetchMock)[0]![1] as { headers: Record<string, string> }).headers['Idempotency-Key']).toBe(`daily-${t}`);
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
