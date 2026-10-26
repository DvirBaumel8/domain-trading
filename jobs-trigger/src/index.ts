export type Job = 'tick' | 'daily';

export interface Env {
  API_BASE_URL?: string;
  JOB_TRIGGER_TOKEN?: string;
  /** BUG-044: service binding to the api-proxy Worker (CR-041). Cloudflare refuses a Worker's plain fetch of another
   * workers.dev Worker on the same account, so while API_BASE_URL is the proxy the calls go through this binding. */
  API?: { fetch: (request: Request) => Promise<Response> };
}

/** The proxy Worker's own host prefix (`domain-trading-api-proxy.<subdomain>.workers.dev`). */
export const PROXY_HOST_PREFIX = 'domain-trading-api-proxy.';

export interface Logger {
  error: (message: string) => void;
  /** Optional: the run id of the queued run is logged here (console.info in the Worker). */
  info?: (message: string) => void;
}

/** Since 3.0.0 POST /jobs/run only enqueues and answers 202, so this no longer has to cover a whole run. */
export const TIMEOUT_MS = 30_000;
/** The wake-up GET /health/ping (the free instance sleeps): a failure never stops the job, it only costs this long. */
export const WAKE_TIMEOUT_MS = 90_000; // v3.9.0: was 30 s; a cold Render free instance can take over a minute
/** Up to 6 tries of the POST (five retries after a network error or a 5xx, waiting 5, 15, 30, 60 then 90 s = 200 s, about 3 minutes, enough for the Mac host or a tunnel to come back); the same Idempotency-Key, so the server never runs it twice. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 90_000];
export const RETRY_DELAY_MS = RETRY_DELAYS_MS[0]!;

// One cron trigger here: 00:05 UTC runs `daily` (it includes the former hourly steps: reconciler, nsVerifier, screeningResume).
// The `tick` is NOT scheduled by this Worker (the Cloudflare account is at the Workers Free limit of cron triggers):
// .github/workflows/tick.yml runs it at 08:30 UTC.
export const DAILY_CRON = '5 0 * * *';
export const CRONS: Record<string, Job> = { [DAILY_CRON]: 'daily' };

export function jobsFor(cron: string): Job[] {
  const job = CRONS[cron];
  return job ? [job] : [];
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Calls the fetcher with its own timeout; returns the response, or the failure text (aborted = timed out). */
async function attempt(fetcher: Fetcher, url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return { res: await fetcher(url, { ...init, signal: controller.signal }) };
  } catch (err) {
    return { error: controller.signal.aborted ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : 'unknown error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function triggerJob(
  job: Job,
  env: Env,
  scheduledTime: number,
  fetcher: Fetcher,
  logger: Logger,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const base = env.API_BASE_URL?.trim();
  const token = env.JOB_TRIGGER_TOKEN?.trim();
  if (!base || !token) {
    logger.error(`jobs-trigger ${job}: API_BASE_URL or JOB_TRIGGER_TOKEN is not configured`);
    return;
  }
  if (!base.startsWith('https://')) {
    logger.error(`jobs-trigger ${job}: API_BASE_URL must start with https://`);
    return;
  }
  const root = base.replace(/\/+$/, '');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Wake the instance first; whatever happens here, the POST is still tried.
  await attempt(fetcher, `${root}/health/ping`, { method: 'GET' }, WAKE_TIMEOUT_MS);
  const post = () => attempt(fetcher, `${root}/jobs/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `${job}-${scheduledTime}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job }),
  }, TIMEOUT_MS);
  let r = await post();
  for (const delay of RETRY_DELAYS_MS) {
    if (!('error' in r || r.res.status >= 500)) break;
    await sleep(delay);
    r = await post();
  }
  if ('error' in r) {
    logger.error(`jobs-trigger ${job} failed: ${r.error.split(token).join('[redacted]')}`);
    return;
  }
  if (!r.res.ok) {
    logger.error(`jobs-trigger ${job} returned HTTP ${r.res.status}`);
    return;
  }
  // 202: the run is queued and the server works it (results are in GET /jobs/runs). A Worker cron cannot poll, so it only logs the run id.
  try {
    const body = (await r.res.json()) as { run_id?: unknown; skipped?: unknown } | null;
    const id = typeof body?.run_id === 'string' ? body.run_id : 'unknown';
    logger.info?.(`jobs-trigger ${job}: ${body?.skipped === true ? 'already queued or running, run' : 'queued run'} ${id}`);
  } catch {
    // an unreadable body on a 2xx is not a failure of the job
  }
}

/** BUG-044: the service binding when API_BASE_URL is the api-proxy Worker and the binding exists; plain fetch otherwise (Render). */
export function fetcherFor(env: Env, plain: Fetcher): Fetcher {
  let host = '';
  try { host = new URL(env.API_BASE_URL?.trim() ?? '').host; } catch { /* triggerJob reports a bad URL */ }
  const binding = env.API;
  if (!binding || !host.startsWith(PROXY_HOST_PREFIX)) return plain;
  return (url, init) => binding.fetch(new Request(url, init));
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const jobs = jobsFor(controller.cron);
    if (jobs.length === 0) {
      console.error(`jobs-trigger: unknown cron "${controller.cron}"`);
      return;
    }
    for (const job of jobs) await triggerJob(job, env, controller.scheduledTime, fetcherFor(env, fetch), console);
  },
};
