export type Job = 'tick' | 'daily';

export interface Env {
  API_BASE_URL?: string;
  JOB_TRIGGER_TOKEN?: string;
}

export interface Logger {
  error: (message: string) => void;
}

export const TIMEOUT_MS = 90_000;

// Two cron triggers (CR-005 Amendment A, then CR-011 addendum C): 00:05 UTC runs `daily` (it includes the former hourly steps: reconciler,
// nsVerifier, screeningResume); 07:30 UTC (10:30 IDT, after Google's daily quota reset in both seasons) runs `tick`, whose reviewRetry
// step retries a review that got a 429 in the daily run.
export const DAILY_CRON = '5 0 * * *';
export const TICK_CRON = '30 7 * * *';
export const CRON = DAILY_CRON;
export const CRONS: Record<string, Job> = { [DAILY_CRON]: 'daily', [TICK_CRON]: 'tick' };

export function jobsFor(cron: string): Job[] {
  const job = CRONS[cron];
  return job ? [job] : [];
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function triggerJob(
  job: Job,
  env: Env,
  scheduledTime: number,
  fetcher: Fetcher,
  logger: Logger,
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(`${base.replace(/\/+$/, '')}/jobs/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `${job}-${scheduledTime}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.error(`jobs-trigger ${job} returned HTTP ${res.status}`);
    }
  } catch (err) {
    const reason = controller.signal.aborted
      ? `timed out after ${TIMEOUT_MS} ms`
      : err instanceof Error
        ? err.message
        : 'unknown error';
    logger.error(`jobs-trigger ${job} failed: ${reason.split(token).join('[redacted]')}`);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const jobs = jobsFor(controller.cron);
    if (jobs.length === 0) {
      console.error(`jobs-trigger: unknown cron "${controller.cron}"`);
      return;
    }
    for (const job of jobs) await triggerJob(job, env, controller.scheduledTime, fetch, console);
  },
};
