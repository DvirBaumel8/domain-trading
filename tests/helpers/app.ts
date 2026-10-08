import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { z } from 'zod';
import type { NsLookup } from '../../src/core/ns-lookup.js';
import type { RdapFn } from '../../src/core/rdap.js';
import type { RegistrarAdapter } from '../../src/modules/registrars/types.js';
import { buildApp, type AppDeps } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/types.js';
import type { AuditWriter } from '../../src/http/audit.js';
import type { HoldoutCheck } from '../../src/modules/selection/settings.js';
import { testDb } from './db.js';
import { testEnv } from './env.js';

/** Counts handler executions, to prove side effects happen once. */
export const sideEffects = { count: 0 };

export function registerTestRoutes(app: FastifyInstance): void {
  app.get('/__test/ping', async () => ({ pong: true }));

  app.post('/__test/echo', async (req, reply) => {
    const body = z
      .object({
        value: z.string(),
        approval_ref: z.object({ text: z.string(), approved_at: z.string() }).strict().optional(),
      })
      .strict()
      .parse(req.body);
    sideEffects.count += 1;
    return reply.code(201).send({ echo: body.value, n: sideEffects.count });
  });

  app.get(
    '/__test/schema',
    { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } } },
    async () => ({ ok: true }),
  );

  app.post('/__test/boom', async () => {
    sideEffects.count += 1;
    throw new Error('boom');
  });

  app.post('/__test/slow', async (_req, reply) => {
    await new Promise((r) => setTimeout(r, 300));
    sideEffects.count += 1;
    return reply.code(201).send({ ok: true });
  });
}

export function logCapture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

export async function makeApp(
  opts: {
    now?: () => number;
    audit?: AuditWriter;
    testRoutes?: boolean;
    logStream?: Writable;
    db?: Kysely<Database>;
    env?: Record<string, string>;
    adapters?: RegistrarAdapter[];
    rdap?: RdapFn;
    quoteTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nsLookup?: NsLookup;
    exportLockTimeoutMs?: number;
    backupExport?: { runOnce(): Promise<unknown> };
    holdoutCheck?: HoldoutCheck;
    screeningStopAfterResults?: number;
    screening?: AppDeps['screening'];
    jobQueueOverrides?: AppDeps['jobQueueOverrides'];
    jobQueueKeepAlive?: AppDeps['jobQueueKeepAlive'];
  } = {},
): Promise<FastifyInstance> {
  sideEffects.count = 0;
  const app = await buildApp({
    config: loadConfig(testEnv(opts.env)),
    db: opts.db ?? testDb,
    now: opts.now,
    audit: opts.audit,
    adapters: opts.adapters,
    rdap: opts.rdap,
    nsLookup: opts.nsLookup ?? (async () => null),
    quoteTimeoutMs: opts.quoteTimeoutMs,
    exportLockTimeoutMs: opts.exportLockTimeoutMs,
    backupExport: opts.backupExport,
    holdoutCheck: opts.holdoutCheck,
    screeningStopAfterResults: opts.screeningStopAfterResults,
    jobQueueOverrides: opts.jobQueueOverrides,
    jobQueueKeepAlive: opts.jobQueueKeepAlive,
    // No live DNS in tests: a test that needs name servers passes fakes.
    screening: {
      resolveNs: async () => { throw new Error('DNS blocked in tests'); },
      resolve4: async () => { throw new Error('DNS blocked in tests'); },
      ...opts.screening,
    },
    sleep: opts.sleep ?? (async () => {}),
    logger: opts.logStream ? { level: 'info', stream: opts.logStream } : false,
    registerExtraRoutes: opts.testRoutes === false ? undefined : registerTestRoutes,
  });
  await app.ready();
  return app;
}

const TEST_JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
let jobKeyN = 0;

/**
 * POST /jobs/run (202, v3.0.0), then waits for this app's queue worker to finish, and returns the run in the shape the endpoint had before 3.0.0:
 * `json()` = {job, skipped, steps:{name:{ok, skipped?, error?, ms, summary, status, attempts,...}}}. `statusCode` is the POST's (202).
 * An overlap (the open run of the same job) comes back as {job, skipped:true, steps:{}} without waiting.
 */
export async function runJobToEnd(
  app: FastifyInstance, job: string, opts: { headers?: Record<string, string>; key?: string } = {},
): Promise<JobRunToEnd> {
  const res = await app.inject({
    method: 'POST', url: '/jobs/run',
    headers: { ...(opts.headers ?? { authorization: `Bearer ${TEST_JOB_TOKEN}` }), 'idempotency-key': opts.key ?? `run-to-end-${++jobKeyN}-${Date.now()}` },
    payload: { job },
  });
  return settleJob(app, job, res);
}

export interface JobRunToEnd {
  statusCode: number; headers: Record<string, unknown>; body: string;
  accepted: { run_id: string; skipped: boolean; steps: string[] };
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Takes a POST /jobs/run response you already have, waits for the worker, and returns the run as `runJobToEnd` does. */
export async function settleJob(app: FastifyInstance, job: string, res: { statusCode: number; headers: Record<string, unknown>; body: string; json: () => any }): Promise<JobRunToEnd> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (res.statusCode !== 202) return { statusCode: res.statusCode, headers: res.headers, body: res.body, accepted: res.json(), json: () => res.json() };
  const accepted = res.json() as { run_id: string; skipped: boolean; steps: string[] };
  if (accepted.skipped) return { statusCode: 202, headers: res.headers, body: res.body, accepted, json: () => ({ job, skipped: true, steps: {} }) };
  await app.jobQueue.idle();
  const row = await testDb.selectFrom('job_runs').selectAll().where('queue_run_id', '=', accepted.run_id).executeTakeFirst();
  if (!row) throw new Error(`run ${accepted.run_id} did not finish (the job lock may be held elsewhere)`);
  return { statusCode: 202, headers: res.headers, body: res.body, accepted, json: () => ({ run_id: accepted.run_id, job: row.job, skipped: false, ok: row.ok, steps: row.steps, started_at: row.started_at.toISOString(), finished_at: row.finished_at.toISOString() }) };
}
