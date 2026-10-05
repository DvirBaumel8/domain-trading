import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { scheduleDailyUtc } from './daily-timer.js';

/**
 * Starts the in-process timers and startup runs. JOBS_MODE=external (production) starts nothing:
 * the external trigger calls POST /jobs/run instead. Returns a stop function.
 */
export function startJobScheduling(app: FastifyInstance, config: Pick<Config, 'jobsMode'>): () => void {
  if (config.jobsMode === 'external') return () => {};
  const err = (what: string) => (e: unknown) => app.log.error({ errMessage: (e as Error).message }, `${what} failed`);
  const timers: NodeJS.Timeout[] = [];

  const runReconciler = () => app.reconciler.runOnce().catch(err('reconciler'));
  void runReconciler(); // at startup
  timers.push(setInterval(runReconciler, 10 * 60_000).unref()); // and every 10 minutes

  const runNsVerifier = () => app.nsVerifier.runOnce().catch(err('ns verifier'));
  void runNsVerifier(); // at startup
  timers.push(setInterval(runNsVerifier, 24 * 3_600_000).unref()); // and every 24 hours

  const runDaily = async () => {
    await app.priceJob.runOnce().catch(err('price job'));
    await app.dropJob.runOnce().catch(err('drop job'));
    await app.registrarCheckJob.runOnce().catch(err('registrar check'));
  };
  void runDaily(); // at startup (catches up after downtime; idempotent)
  const stopDaily = scheduleDailyUtc(runDaily, 0, 30); // and daily at 00:30 UTC: price job, drop job, then registrar check

  return () => {
    for (const t of timers) clearInterval(t);
    stopDaily();
  };
}
