import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { pingDb } from '../db/client.js';
import type { Database } from '../db/types.js';
import { adapterStatus } from '../registrars/registry.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>): void {
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}
