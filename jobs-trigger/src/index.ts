export type Job = 'tick' | 'daily';

export interface Env {
  API_BASE_URL?: string;
  JOB_TRIGGER_TOKEN?: string;
}

export interface Logger {
  error: (message: string) => void;
}

export const TIMEOUT_MS = 90_000;

const CRON_JOBS: Record<string, Job> = {
  '0 * * * *': 'tick',
  '30 0 * * *': 'daily',
};

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function triggerJob(
  job: Job,
  env: Env,
  scheduledTime: number,
  fetcher: Fetcher,
  logger: Logger,
): Promise<void> {
  const base = env.API_BASE_URL?.trim();
  const token = env.JOB_TRIGGER_TOKEN;
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
    const job = CRON_JOBS[controller.cron];
    if (!job) {
      console.error(`jobs-trigger: unknown cron "${controller.cron}"`);
      return;
    }
    await triggerJob(job, env, controller.scheduledTime, fetch, console);
  },
};
