const DAY_MS = 24 * 3_600_000;

/** Milliseconds from `nowMs` until the next HH:MM UTC (strictly in the future). */
export function msUntilNextUtc(nowMs: number, hour: number, minute: number): number {
  const d = new Date(nowMs);
  let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  if (target <= nowMs) target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, hour, minute, 0, 0);
  return target - nowMs;
}

/** Runs `fn` at the next HH:MM UTC and then every day; the delay is recomputed after each run. Returns a stop function. Timers are unref'd. */
export function scheduleDailyUtc(fn: () => Promise<unknown>, hour: number, minute: number, now: () => number = Date.now): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await fn();
      } catch {
        // the chain continues; callers log inside fn
      }
      arm();
    }, msUntilNextUtc(now(), hour, minute));
    timer.unref();
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
