import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { Writable } from 'node:stream';
import { z } from 'zod';
import type { RdapFn } from '../../src/rdap.js';
import type { RegistrarAdapter } from '../../src/registrars/types.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/types.js';
import type { AuditWriter } from '../../src/http/audit.js';
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
    quoteTimeoutMs: opts.quoteTimeoutMs,
    logger: opts.logStream ? { level: 'info', stream: opts.logStream } : false,
    registerExtraRoutes: opts.testRoutes === false ? undefined : registerTestRoutes,
  });
  await app.ready();
  return app;
}
