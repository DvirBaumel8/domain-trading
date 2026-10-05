import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobRunner } from '../jobs/runner.js';

const Body = z.object({ job: z.enum(['tick', 'daily']) }).strict();

/** POST /jobs/run: called by the external scheduler (Cloudflare Worker). Auth is the job-trigger bearer (see http/auth.ts). */
export function registerJobs(app: FastifyInstance, runner: JobRunner): void {
  app.post('/jobs/run', async (req, reply) => {
    const { job } = Body.parse(req.body);
    const started = new Date().toISOString();
    const result = await runner.run(job);
    const failed = Object.entries(result.steps).filter(([, s]) => !s.ok).map(([k]) => k);
    req.auditSummary = result.skipped ? `${job}: skipped` : failed.length ? `${job}: failed ${failed.join(',')}` : `${job}: ok`;
    return reply.code(200).send({ ...result, started_at: started, finished_at: new Date().toISOString() });
  });
}
